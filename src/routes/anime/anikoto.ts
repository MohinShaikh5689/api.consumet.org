import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { ANIME } from '@consumet/extensions';
import { StreamingServers, SubOrSub } from '@consumet/extensions/dist/models';
import axios from 'axios';

import cache from '../../utils/cache';
import { redis, REDIS_TTL } from '../../main';
import { Redis } from 'ioredis';

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;

/**
 * Minimum length of a subtitle segment, in seconds.
 *
 * Trades request count against segment size. Video segments here are ~4s, so
 * grouping to 30s turns ~355 subtitle requests into ~47 — the burst that
 * starved video fetching becomes short enough to absorb, while segments stay
 * far smaller than the whole programme.
 */
const SUBTITLE_SEGMENT_TARGET_SECONDS = 30;

/**
 * The CDN hides each MPEG-TS segment behind a junk prefix: a tiny valid PNG
 * followed by a decoy 182-byte packet whose leading 0x47 and embedded SDT
 * string make it look like the stream has already started. Trusting that
 * decoy leaves the real stream misaligned and the segment fails to decode.
 *
 * A transport stream is a strict run of 188-byte packets each starting with
 * 0x47, so the genuine start is recoverable: only offsets that leave a whole
 * number of packets can be right, and the true one has a sync byte at every
 * boundary. Deriving it keeps this working if the padding ever changes.
 */
const LANGUAGE_CODES: Record<string, string> = {
  english: 'en',
  spanish: 'es',
  portuguese: 'pt',
  french: 'fr',
  german: 'de',
  japanese: 'ja',
  italian: 'it',
  arabic: 'ar',
  russian: 'ru',
  hindi: 'hi',
  indonesian: 'id',
  thai: 'th',
  korean: 'ko',
  chinese: 'zh',
};

interface SubtitleSpec {
  url: string;
  lang: string;
  /**
   * Language tag chosen by the client. Sources often ship two variants of one
   * language, and a repeated tag makes the second unselectable, so the client
   * resolves collisions and this is used verbatim when present.
   */
  code?: string;
}

function languageCode(label: string): string {
  const key = label.toLowerCase().split(/[\s(\-]/)[0];
  return LANGUAGE_CODES[key] ?? (key.slice(0, 2) || 'und');
}

/** `subs` travels as base64 JSON so subtitle URLs keep their own query strings intact. */
function decodeSubtitleSpecs(raw?: string): SubtitleSpec[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s: any) => s && typeof s.url === 'string');
  } catch {
    return [];
  }
}

/** Total playlist runtime, needed so the subtitle rendition spans the whole video. */
function sumPlaylistDuration(playlist: string): number {
  return segmentDurations(playlist).reduce((total, d) => total + d, 0);
}

/** Per-segment durations, in playlist order. */
function segmentDurations(playlist: string): number[] {
  return segmentDurationStrings(playlist)
    .map((d) => parseFloat(d))
    .filter((d) => !isNaN(d));
}

/**
 * Raw EXTINF values, kept as written. A subtitle rendition has to line up with
 * the video segment for segment, so its durations are copied verbatim rather
 * than re-formatted — reprinting them rounds each one and the totals drift.
 */
function segmentDurationStrings(playlist: string): string[] {
  const out: string[] = [];
  for (const line of playlist.split('\n')) {
    if (line.startsWith('#EXTINF:')) out.push(line.slice(8).split(',')[0].trim());
  }
  return out;
}

// A subtitle rendition is re-requested once per segment, so without this the
// same VTT would be pulled from the origin hundreds of times per episode.
const textCache = new Map<string, { body: string; expires: number }>();
const TEXT_CACHE_TTL_MS = 5 * 60 * 1000;
const TEXT_CACHE_MAX = 64;

async function fetchTextCached(url: string, headers: Record<string, string>): Promise<string> {
  const hit = textCache.get(url);
  if (hit && hit.expires > Date.now()) return hit.body;

  const { data } = await axios.get(url, { headers, responseType: 'text' });
  const body = String(data);

  if (textCache.size >= TEXT_CACHE_MAX) {
    const oldest = textCache.keys().next().value;
    if (oldest) textCache.delete(oldest);
  }
  textCache.set(url, { body, expires: Date.now() + TEXT_CACHE_TTL_MS });
  return body;
}

/**
 * Recently de-obfuscated segments, keyed by upstream URL.
 *
 * A Range request cannot be forwarded upstream because the junk prefix has to
 * be stripped from the whole file first, so without this every range re-pulls
 * the entire segment. A seek issues several in a burst, and at multiple
 * megabytes each that was enough to blow the request timeout.
 */
const segmentCache = new Map<string, { buffer: Buffer; expires: number }>();
const SEGMENT_CACHE_TTL_MS = 60 * 1000;
const SEGMENT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
let segmentCacheBytes = 0;

function getCachedSegment(url: string): Buffer | null {
  const hit = segmentCache.get(url);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    segmentCache.delete(url);
    segmentCacheBytes -= hit.buffer.length;
    return null;
  }
  return hit.buffer;
}

function cacheSegment(url: string, buffer: Buffer): void {
  // Evict oldest first; Map preserves insertion order.
  while (segmentCacheBytes + buffer.length > SEGMENT_CACHE_MAX_BYTES && segmentCache.size > 0) {
    const oldest = segmentCache.keys().next().value;
    if (!oldest) break;
    const entry = segmentCache.get(oldest);
    segmentCache.delete(oldest);
    if (entry) segmentCacheBytes -= entry.buffer.length;
  }
  segmentCache.set(url, { buffer, expires: Date.now() + SEGMENT_CACHE_TTL_MS });
  segmentCacheBytes += buffer.length;
}

function parseVttTime(value: string): number | null {
  const m = value.match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
  if (!m) return null;
  return (
    (m[1] ? parseInt(m[1], 10) : 0) * 3600 +
    parseInt(m[2], 10) * 60 +
    parseInt(m[3], 10) +
    parseInt(m[4].padEnd(3, '0'), 10) / 1000
  );
}

/**
 * Cues overlapping [start, end). Timestamps stay on the programme timeline —
 * HLS expects each WebVTT segment to carry absolute times plus the
 * X-TIMESTAMP-MAP, not times rebased to the segment.
 */
function sliceVttCues(body: string, start: number, end: number): string[] {
  const out: string[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const arrow = block.indexOf('-->');
    if (arrow === -1) continue;

    const lineStart = block.lastIndexOf('\n', arrow) + 1;
    const lineEnd = block.indexOf('\n', arrow);
    const timing = block.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    const [from, to] = timing.split('-->');

    const cueStart = parseVttTime(from ?? '');
    const cueEnd = parseVttTime(to ?? '');
    if (cueStart === null || cueEnd === null) continue;
    // A cue straddling a boundary belongs to both segments, or it flickers out.
    if (cueEnd > start && cueStart < end) out.push(block.trim());
  }
  return out;
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '');
}

/**
 * First presentation timestamp in the stream, in 90kHz ticks.
 *
 * HLS WebVTT is timed against the MPEG-TS clock, not against zero. These
 * segments start at a non-zero PTS, so without this offset every cue is
 * anchored to the wrong origin and AVPlayer shows nothing at all.
 */
function extractFirstPts(buffer: Buffer): number | null {
  for (let offset = 0; offset + TS_PACKET_SIZE <= buffer.length; offset += TS_PACKET_SIZE) {
    if (buffer[offset] !== TS_SYNC_BYTE) continue;

    const payloadStart = (buffer[offset + 1] & 0x40) !== 0;
    const adaptationControl = (buffer[offset + 3] & 0x30) >> 4;
    if (!payloadStart || adaptationControl === 2) continue;

    let p = offset + 4;
    if (adaptationControl === 3) p += buffer[offset + 4] + 1;
    if (p + 14 > buffer.length) continue;

    // PES packet start code prefix
    if (buffer[p] !== 0x00 || buffer[p + 1] !== 0x00 || buffer[p + 2] !== 0x01) continue;
    // Only audio (0xC0-0xDF) and video (0xE0-0xEF) streams carry a PTS.
    const streamId = buffer[p + 3];
    if (streamId < 0xc0 || streamId > 0xef) continue;
    if ((buffer[p + 7] & 0x80) === 0) continue;

    // 33-bit value, so the top bits are scaled rather than shifted.
    return (
      (buffer[p + 9] & 0x0e) * 536870912 +
      ((buffer[p + 10] & 0xff) << 22) +
      ((buffer[p + 11] & 0xfe) << 14) +
      ((buffer[p + 12] & 0xff) << 7) +
      ((buffer[p + 13] & 0xfe) >> 1)
    );
  }
  return null;
}

/**
 * Transport stream start within a partial segment.
 *
 * findTransportStreamStart anchors on the buffer length to rule out offsets
 * that would leave a fractional packet, which needs the whole segment. When
 * only a prefix has been fetched, the run of sync bytes is the only signal
 * left, so scan for it directly.
 */
function findTsStartInPrefix(buffer: Buffer): number {
  const limit = Math.min(8192, buffer.length);
  for (let offset = 0; offset < limit; offset++) {
    if (buffer[offset] !== TS_SYNC_BYTE) continue;

    let boundaries = 0;
    let aligned = true;
    for (
      let p = offset;
      p + TS_PACKET_SIZE <= buffer.length && boundaries < 20;
      p += TS_PACKET_SIZE, boundaries++
    ) {
      if (buffer[p] !== TS_SYNC_BYTE) {
        aligned = false;
        break;
      }
    }
    if (aligned && boundaries >= 5) return offset;
  }
  return -1;
}

/**
 * Per-master stream facts needed to build subtitle renditions. Deriving these
 * costs a playlist fetch plus a segment probe, and a player asks for the
 * master more than once, so the work is kept rather than repeated.
 */
interface StreamMeta {
  duration: number;
  mpegTsOffset: number;
  variantUrl: string;
}
const streamMetaCache = new Map<string, { meta: StreamMeta; expires: number }>();
const STREAM_META_TTL_MS = 5 * 60 * 1000;

function findTransportStreamStart(buffer: Buffer): number {
  const maxPrefix = Math.min(8192, buffer.length);
  for (
    let offset = buffer.length % TS_PACKET_SIZE;
    offset < maxPrefix;
    offset += TS_PACKET_SIZE
  ) {
    let boundaries = 0;
    let aligned = true;
    for (let p = offset; p + TS_PACKET_SIZE <= buffer.length; p += TS_PACKET_SIZE) {
      if (buffer[p] !== TS_SYNC_BYTE) {
        aligned = false;
        break;
      }
      if (++boundaries >= 20) break;
    }
    if (aligned && boundaries > 0) return offset;
  }
  return -1;
}

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  const anikoto = new ANIME.AniKoto();

  // Set ANIKOTO_TRACE=<file> to record what a player actually requests and in
  // what order. Playback failures here are otherwise invisible: the client is
  // a black box that just stops, with no error surfaced anywhere.
  if (process.env.ANIKOTO_TRACE) {
    const tracePath = process.env.ANIKOTO_TRACE;
    fastify.addHook('onRequest', async (request: FastifyRequest) => {
      const route = request.url.split('?')[0].replace('/anime/anikoto/', '');
      const query = request.url.includes('?') ? request.url.split('?')[1] : '';
      const detail =
        [/start=([\d.]+)/, /dur=([\d.]+)/, /x-expires/]
          .map((re) => query.match(re)?.[0])
          .filter(Boolean)
          .join(' ') || '';
      try {
        require('fs').appendFileSync(
          tracePath,
          `${new Date().toISOString().slice(11, 23)} ${route} ${detail}\n`,
        );
      } catch {
        // Tracing must never break a request.
      }
    });
  }

  fastify.get('/', (_, rp) => {
    rp.status(200).send({
      intro: `Welcome to the anikoto provider: check out the provider's website @ ${anikoto.toString.baseUrl}`,
      routes: [
        '/:query',
        '/info',
        '/watch/:episodeId',
        '/advanced-search',
        '/top-airing',
        '/most-popular',
        '/most-favorite',
        '/latest-completed',
        '/recently-updated',
        '/recently-added',
        '/top-upcoming',
        '/studio/:studio',
        '/subbed-anime',
        '/dubbed-anime',
        '/movie',
        '/tv',
        '/ova',
        '/ona',
        '/special',
        '/genres',
        '/genre/:genre',
        '/schedule',
        '/spotlight',
        '/search-suggestions/:query',
      ],
      documentation: 'https://docs.consumet.org/#tag/anikoto',
    });
  });

  fastify.get(
    '/:query',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'number' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = (request.params as { query: string }).query;
      const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:search:${query}:${page}`,
            async () => await anikoto.search(query, page),
            REDIS_TTL,
          )
        : await anikoto.search(query, page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get(
    '/info',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = (request.query as { id: string }).id;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:info:${id}`,
            async () => await anikoto.fetchAnimeInfo(id),
            REDIS_TTL,
          )
        : await anikoto.fetchAnimeInfo(id);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get(
    '/watch/:episodeId',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            episodeId: { type: 'string' },
          },
          required: ['episodeId'],
        },
        querystring: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'The server name (e.g. HD-1, Vidstream-2)' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const episodeId = (request.params as { episodeId: string }).episodeId;
      const { server } = request.query as { server?: string };

      if (typeof episodeId === 'undefined')
        return reply.status(400).send({ message: 'episodeId is required' });

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `anikoto:watch:${episodeId}:${server || 'default'}`,
              async () => await anikoto.fetchEpisodeSources(episodeId, server as any),
              REDIS_TTL,
            )
          : await anikoto.fetchEpisodeSources(episodeId, server as any);

        const hostUrl = `${request.protocol}://${request.hostname}`;

        if (res.sub?.sources) {
          res.sub.sources = res.sub.sources.map((src: any) => {
            if (src.url) {
              const originalUrl = src.url;
              const referer = src.headers?.Referer || src.headers?.referer || '';
              src.url = `${hostUrl}/anime/anikoto/m3u8-proxy?url=${encodeURIComponent(originalUrl)}&referer=${encodeURIComponent(referer)}`;
            }
            return src;
          });
          if (res.sub.download) {
            const originalDownload = res.sub.download;
            const referer = res.sub.sources?.[0]?.headers?.Referer || '';
            res.sub.download = `${hostUrl}/anime/anikoto/m3u8-proxy?url=${encodeURIComponent(originalDownload)}&referer=${encodeURIComponent(referer)}`;
          }
        }

        if (res.dub?.sources) {
          res.dub.sources = res.dub.sources.map((src: any) => {
            if (src.url) {
              const originalUrl = src.url;
              const referer = src.headers?.Referer || src.headers?.referer || '';
              src.url = `${hostUrl}/anime/anikoto/m3u8-proxy?url=${encodeURIComponent(originalUrl)}&referer=${encodeURIComponent(referer)}`;
            }
            return src;
          });
          if (res.dub.download) {
            const originalDownload = res.dub.download;
            const referer = res.dub.sources?.[0]?.headers?.Referer || '';
            res.dub.download = `${hostUrl}/anime/anikoto/m3u8-proxy?url=${encodeURIComponent(originalDownload)}&referer=${encodeURIComponent(referer)}`;
          }
        }

        reply.status(200).send(res);
      } catch (err) {
        reply
          .status(500)
          .send({ message: 'Something went wrong. Contact developer for help.' });
      }
    },
  );

  fastify.get('/genres', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:genres`,
            async () => await anikoto.fetchGenres(),
            REDIS_TTL,
          )
        : await anikoto.fetchGenres();

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get(
    '/schedule',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Date in YYYY-MM-DD format (default: today)' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const date = (request.query as { date?: string }).date || new Date().toISOString().slice(0, 10);

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:schedule:${date}`,
            async () => await anikoto.fetchSchedule(date),
            REDIS_TTL,
          )
        : await anikoto.fetchSchedule(date);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/spotlight', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:spotlight`,
            async () => await anikoto.fetchSpotlight(),
            REDIS_TTL,
          )
        : await anikoto.fetchSpotlight();

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get(
    '/search-suggestions/:query',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = (request.params as { query: string }).query;

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `anikoto:suggestions:${query}`,
              async () => await anikoto.fetchSearchSuggestions(query),
              REDIS_TTL,
            )
          : await anikoto.fetchSearchSuggestions(query);

        reply.status(200).send(res);
      } catch (err) {
        reply
          .status(500)
          .send({ message: 'Something went wrong. Contact developer for help.' });
      }
    },
  );

  fastify.get(
    '/advanced-search',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'number' },
            type: { type: 'string' },
            status: { type: 'string' },
            rated: { type: 'string' },
            score: { type: 'number' },
            season: { type: 'string' },
            language: { type: 'string' },
            startDate: { type: 'string' },
            endDate: { type: 'string' },
            sort: { type: 'string' },
            genres: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const queryParams = request.query as {
        page?: number;
        type?: string;
        status?: string;
        rated?: string;
        score?: number;
        season?: string;
        language?: string;
        startDate?: string;
        endDate?: string;
        sort?: string;
        genres?: string;
      };

      const {
        page = 1,
        type,
        status,
        rated,
        score,
        season,
        language,
        startDate,
        endDate,
        sort,
        genres,
      } = queryParams;

      try {
        // Explicitly typed to avoid implicit any errors
        let parsedStartDate: { year: number; month: number; day: number } | undefined;
        let parsedEndDate: { year: number; month: number; day: number } | undefined;

        if (startDate) {
          const [year, month, day] = startDate.split('-').map(Number);
          parsedStartDate = { year, month, day };
        }
        if (endDate) {
          const [year, month, day] = endDate.split('-').map(Number);
          parsedEndDate = { year, month, day };
        }

        const genresArray = genres ? genres.split(',') : undefined;

        // Create a unique key based on all parameters
        const cacheKey = `anikoto:advanced-search:${JSON.stringify(queryParams)}`;

        let res = redis
          ? await cache.fetch(
              redis as Redis,
              cacheKey,
              async () =>
                await anikoto.fetchAdvancedSearch(
                  page,
                  type,
                  status,
                  rated,
                  score,
                  season,
                  language,
                  parsedStartDate,
                  parsedEndDate,
                  sort,
                  genresArray,
                ),
              REDIS_TTL,
            )
          : await anikoto.fetchAdvancedSearch(
              page,
              type,
              status,
              rated,
              score,
              season,
              language,
              parsedStartDate,
              parsedEndDate,
              sort,
              genresArray,
            );

        reply.status(200).send(res);
      } catch (err) {
        reply
          .status(500)
          .send({ message: 'Something went wrong. Contact developer for help.' });
      }
    },
  );

  fastify.get('/top-airing', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:top-airing:${page}`,
            async () => await anikoto.fetchTopAiring(page),
            REDIS_TTL,
          )
        : await anikoto.fetchTopAiring(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/most-popular', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:most-popular:${page}`,
            async () => await anikoto.fetchMostPopular(page),
            REDIS_TTL,
          )
        : await anikoto.fetchMostPopular(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/most-favorite', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:most-favorite:${page}`,
            async () => await anikoto.fetchMostFavorite(page),
            REDIS_TTL,
          )
        : await anikoto.fetchMostFavorite(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get(
    '/latest-completed',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const page = (request.query as { page: number }).page;

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `anikoto:latest-completed:${page}`,
              async () => await anikoto.fetchLatestCompleted(page),
              REDIS_TTL,
            )
          : await anikoto.fetchLatestCompleted(page);

        reply.status(200).send(res);
      } catch (err) {
        reply
          .status(500)
          .send({ message: 'Something went wrong. Contact developer for help.' });
      }
    },
  );

  fastify.get(
    '/recently-updated',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const page = (request.query as { page: number }).page;

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `anikoto:recently-updated:${page}`,
              async () => await anikoto.fetchRecentlyUpdated(page),
              REDIS_TTL,
            )
          : await anikoto.fetchRecentlyUpdated(page);

        reply.status(200).send(res);
      } catch (err) {
        reply
          .status(500)
          .send({ message: 'Something went wrong. Contact developer for help.' });
      }
    },
  );

  fastify.get('/recently-added', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:recently-added:${page}`,
            async () => await anikoto.fetchRecentlyAdded(page),
            REDIS_TTL,
          )
        : await anikoto.fetchRecentlyAdded(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/top-upcoming', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:top-upcoming:${page}`,
            async () => await anikoto.fetchTopUpcoming(page),
            REDIS_TTL,
          )
        : await anikoto.fetchTopUpcoming(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/studio/:studio', async (request: FastifyRequest, reply: FastifyReply) => {
    const studio = (request.params as { studio: string }).studio;
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:studio:${studio}:${page}`,
            async () => await anikoto.fetchStudio(studio, page),
            REDIS_TTL,
          )
        : await anikoto.fetchStudio(studio, page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/subbed-anime', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:subbed:${page}`,
            async () => await anikoto.fetchSubbedAnime(page),
            REDIS_TTL,
          )
        : await anikoto.fetchSubbedAnime(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/dubbed-anime', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:dubbed:${page}`,
            async () => await anikoto.fetchDubbedAnime(page),
            REDIS_TTL,
          )
        : await anikoto.fetchDubbedAnime(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/movie', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:movie:${page}`,
            async () => await anikoto.fetchMovie(page),
            REDIS_TTL,
          )
        : await anikoto.fetchMovie(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/tv', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:tv:${page}`,
            async () => await anikoto.fetchTv(page),
            REDIS_TTL,
          )
        : await anikoto.fetchTv(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/ova', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:ova:${page}`,
            async () => await anikoto.fetchOva(page),
            REDIS_TTL,
          )
        : await anikoto.fetchOva(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/ona', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:ona:${page}`,
            async () => await anikoto.fetchOna(page),
            REDIS_TTL,
          )
        : await anikoto.fetchOna(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/special', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:special:${page}`,
            async () => await anikoto.fetchSpecial(page),
            REDIS_TTL,
          )
        : await anikoto.fetchSpecial(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/genre/:genre', async (request: FastifyRequest, reply: FastifyReply) => {
    const genre = (request.params as { genre: string }).genre;
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:genre:${genre}:${page}`,
            async () => await anikoto.genreSearch(genre, page),
            REDIS_TTL,
          )
        : await anikoto.genreSearch(genre, page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/random', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      let res = await anikoto.search('naruto', 1);
      if (res.results && res.results.length > 0) {
        const randomIndex = Math.floor(Math.random() * res.results.length);
        return reply.status(200).send(res.results[randomIndex]);
      }
      reply.status(404).send({ message: 'No random title found' });
    } catch (err) {
      reply.status(500).send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/az-list/:letter', async (request: FastifyRequest, reply: FastifyReply) => {
    const letter = (request.params as { letter: string }).letter;
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:az-list:${letter}:${page}`,
            async () => await anikoto.fetchAzList(letter, page),
            REDIS_TTL,
          )
        : await anikoto.fetchAzList(letter, page);

      reply.status(200).send(res);
    } catch (err) {
      reply.status(500).send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/watch-order/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `anikoto:watch-order:${id}`,
            async () => await anikoto.fetchWatchOrder(id),
            REDIS_TTL,
          )
        : await anikoto.fetchWatchOrder(id);

      reply.status(200).send(res);
    } catch (err) {
      reply.status(500).send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get(
    '/download/:episodeId',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            episodeId: { type: 'string' },
          },
          required: ['episodeId'],
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const episodeId = (request.params as { episodeId: string }).episodeId;

     try {
       let res = await anikoto.fetchDownloadLinks(episodeId);
       const hostUrl = `${request.protocol}://${request.hostname}`;
       res = res.map((dl: any) => {
         if (dl.downloadUrl && dl.downloadUrl.includes('.m3u8')) {
           const originalUrl = dl.downloadUrl;
           const referer = dl.headers?.Referer || dl.headers?.referer || '';
           dl.downloadUrl = `${hostUrl}/anime/anikoto/m3u8-proxy?url=${encodeURIComponent(originalUrl)}&referer=${encodeURIComponent(referer)}`;
         }
         return dl;
       });
       reply.status(200).send(res);
     } catch (err) {
       reply.status(500).send({ message: 'Something went wrong. Contact developer for help.' });
     }
  });

  fastify.get(
    '/m3u8-proxy',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The absolute M3U8 playlist URL to proxy' },
            referer: { type: 'string', description: 'The Referer header required by the CDN' },
            subs: {
              type: 'string',
              description:
                'base64 JSON [{url,lang}] of sidecar subtitles to advertise as EXT-X-MEDIA renditions',
            },
          },
          required: ['url'],
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
    const { url, referer, subs } = request.query as { url: string; referer?: string; subs?: string };
    if (!url) return reply.status(400).send({ message: 'url is required' });

    try {
      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      };
      if (referer) {
        try {
          const refUrl = new URL(referer);
          headers['Referer'] = `${refUrl.origin}/`;
          headers['Origin'] = refUrl.origin;
        } catch {
          headers['Referer'] = referer;
        }
      }

      const { data } = await axios.get(url, { headers });
      const hostUrl = `${request.protocol}://${request.hostname}`;
      
      const subtitleSpecs = decodeSubtitleSpecs(subs);
      const isMaster = data.includes('#EXT-X-STREAM-INF');
      const proxyBase = `${hostUrl}/anime/anikoto`;
      const refQuery = encodeURIComponent(referer || '');

      // AVPlayer only exposes subtitles that the manifest declares. Sidecar
      // tracks handed to the player directly are ignored for HLS (an
      // AVMutableComposition cannot be built from a remote stream), so the
      // only way to make them selectable is to advertise them here as
      // EXT-X-MEDIA renditions pointing at one-entry subtitle playlists.
      let mediaLines = '';
      if (isMaster && subtitleSpecs.length > 0) {
        let duration = 0;
        let mpegTsOffset = 0;
        let variantForSegmentation = '';

        const cached = streamMetaCache.get(url);
        if (cached && cached.expires > Date.now()) {
          ({ duration, mpegTsOffset, variantUrl: variantForSegmentation } = cached.meta);
        } else {
          try {
            const firstVariant = data
              .split('\n')
              .map((l: string) => l.trim())
              .find((l: string) => l && !l.startsWith('#'));
            if (firstVariant) {
              const variantUrl = firstVariant.startsWith('http')
                ? firstVariant
                : new URL(firstVariant, url).href;
              const variant = await axios.get(variantUrl, { headers });
              duration = sumPlaylistDuration(variant.data);
              variantForSegmentation = variantUrl;

              // The clock start sits in the first few packets, and these
              // segments run to several megabytes — pulling a whole one just to
              // read it added about a second to every master request.
              const firstSegment = variant.data
                .split('\n')
                .map((l: string) => l.trim())
                .find((l: string) => l && !l.startsWith('#'));
              if (firstSegment) {
                const segmentUrl = firstSegment.startsWith('http')
                  ? firstSegment
                  : new URL(firstSegment, variantUrl).href;
                const seg = await axios.get(segmentUrl, {
                  headers: { ...headers, Range: 'bytes=0-131071' },
                  responseType: 'arraybuffer',
                });
                let segBuffer = Buffer.from(seg.data);
                // A prefix cannot be checked for whole-packet division, so the
                // partial-safe scan is the one that applies here.
                const start = findTsStartInPrefix(segBuffer);
                if (start > 0) segBuffer = segBuffer.subarray(start);
                mpegTsOffset = extractFirstPts(segBuffer) ?? 0;
              }
            }

            if (duration > 0) {
              streamMetaCache.set(url, {
                meta: { duration, mpegTsOffset, variantUrl: variantForSegmentation },
                expires: Date.now() + STREAM_META_TTL_MS,
              });
            }
          } catch {
            // Losing these only degrades subtitle timing, so fall through with
            // the defaults rather than failing the whole playlist.
          }
        }
        if (duration <= 0) duration = 86400;

        mediaLines = subtitleSpecs
          .map((sub, i) => {
            const code = sub.code || languageCode(sub.lang || 'und');
            // Players sniff the URL's extension to decide how to treat a
            // rendition, and these endpoints are query strings that end in
            // neither .m3u8 nor .vtt. A fragment never reaches the server but
            // still satisfies that check.
            const trackUrl =
              `${proxyBase}/subtitle-playlist?url=${encodeURIComponent(sub.url)}` +
              `&referer=${refQuery}&duration=${duration.toFixed(3)}&tsoffset=${mpegTsOffset}` +
              `&variant=${encodeURIComponent(variantForSegmentation)}#subtitles.m3u8`;
            return (
              `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",` +
              `NAME="${escapeAttr(sub.lang || code)}",LANGUAGE="${code}",` +
              `AUTOSELECT=YES,DEFAULT=${i === 0 ? 'YES' : 'NO'},FORCED=NO,` +
              `URI="${trackUrl}"`
            );
          })
          .join('\n');
      }

      const lines = data.split('\n');
      const rewrittenLines = lines.map((line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        if (trimmed.startsWith('#')) {
          // The origin CDN's playlists never declare CODECS on
          // EXT-X-STREAM-INF lines. Most players tolerate that by probing
          // the segments themselves, but it's a real HLS-spec gap and a
          // plausible reason a strict demuxer could choke specifically on
          // this content while well-packaged streams play fine elsewhere.
          // Values are this source's actual encode profile, confirmed via
          // ffprobe against a live segment (H.264 High@4.0 + AAC-LC).
          if (trimmed.startsWith('#EXT-X-STREAM-INF')) {
            let out = line;
            if (!trimmed.includes('CODECS')) {
              out = `${out},CODECS="avc1.640028,mp4a.40.2"`;
            }
            // Each variant has to opt into the subtitle group or the renditions
            // above are advertised but never offered against this stream.
            if (mediaLines && !trimmed.includes('SUBTITLES=')) {
              out = `${out},SUBTITLES="subs"`;
            }
            return out;
          }
          return line;
        }

        let absoluteUrl = trimmed;
        if (!trimmed.startsWith('http')) {
          absoluteUrl = new URL(trimmed, url).href;
        }
        
        if (trimmed.includes('.m3u8')) {
          return `${proxyBase}/m3u8-proxy?url=${encodeURIComponent(absoluteUrl)}&referer=${refQuery}`;
        }

        return `${proxyBase}/segment-proxy?url=${encodeURIComponent(absoluteUrl)}&referer=${refQuery}`;
      });

      let body = rewrittenLines.join('\n');
      if (mediaLines) {
        // EXT-X-MEDIA has to precede the variants that reference the group.
        body = body.replace(/#EXT-X-STREAM-INF/, `${mediaLines}\n#EXT-X-STREAM-INF`);
      }

      reply.header('Content-Type', 'application/vnd.apple.mpegurl');
      reply.header('Accept-Ranges', 'bytes');
      reply.status(200).send(body);
    } catch (err: any) {
      reply.status(500).send({ message: err.message });
    }
  });

  // A subtitle rendition must itself be an HLS playlist, not a bare .vtt file.
  // This wraps the sidecar track in a single-segment VOD playlist spanning the
  // whole video so AVPlayer accepts it as a legible media selection option.
  fastify.get(
    '/subtitle-playlist',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The absolute WebVTT URL' },
            referer: { type: 'string', description: 'The Referer header required by the CDN' },
            duration: { type: 'string', description: 'Total programme duration in seconds' },
            tsoffset: { type: 'string', description: 'First PTS of the video, in 90kHz ticks' },
            variant: {
              type: 'string',
              description: 'Video variant playlist whose segmentation this rendition mirrors',
            },
          },
          required: ['url'],
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { url, referer, duration, tsoffset, variant } = request.query as {
        url: string;
        referer?: string;
        duration?: string;
        tsoffset?: string;
        variant?: string;
      };
      if (!url) return reply.status(400).send({ message: 'url is required' });

      const totalSeconds = Math.max(1, Number(duration) || 86400);
      const hostUrl = `${request.protocol}://${request.hostname}`;
      const offset = Number(tsoffset) || 0;

      const headers: Record<string, string> = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      };
      if (referer) {
        try {
          const refUrl = new URL(referer);
          headers['Referer'] = `${refUrl.origin}/`;
          headers['Origin'] = refUrl.origin;
        } catch {
          headers['Referer'] = referer;
        }
      }

      // A rendition has to be segmented like the video it accompanies. One
      // segment spanning the whole programme leaves the player unable to line
      // the renditions up and it stalls a few segments in.
      let durations: string[] = [];
      if (variant) {
        try {
          durations = segmentDurationStrings(await fetchTextCached(variant, headers));
        } catch {
          // Fall through to the single-segment shape below.
        }
      }
      if (durations.length === 0) durations = [totalSeconds.toFixed(3)];

      // Players fetch a subtitle rendition eagerly and in full, one request per
      // segment. Matching the video one-for-one meant ~355 round trips, and
      // while the player worked through them it stopped pulling video segments
      // entirely — playback stalled for as long as the burst lasted. Grouping
      // whole video segments keeps every boundary aligned with a video segment
      // boundary while cutting the request count by an order of magnitude.
      const groups: { duration: number; start: number }[] = [];
      let elapsed = 0;
      let pending = 0;
      let pendingStart = 0;
      for (const segment of durations) {
        const seconds = parseFloat(segment) || 0;
        if (pending === 0) pendingStart = elapsed;
        pending += seconds;
        elapsed += seconds;
        if (pending >= SUBTITLE_SEGMENT_TARGET_SECONDS) {
          groups.push({ duration: pending, start: pendingStart });
          pending = 0;
        }
      }
      if (pending > 0) groups.push({ duration: pending, start: pendingStart });

      const maxGroup = Math.max(...groups.map((g) => g.duration));
      const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        `#EXT-X-TARGETDURATION:${Math.ceil(maxGroup)}`,
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:VOD',
      ];

      for (const group of groups) {
        // The .vtt fragment is what stops the demuxer rejecting the segment on
        // its extension despite a correct Content-Type.
        const vttUrl =
          `${hostUrl}/anime/anikoto/vtt-proxy?url=${encodeURIComponent(url)}` +
          `&referer=${encodeURIComponent(referer || '')}&tsoffset=${offset}` +
          `&start=${group.start.toFixed(6)}&dur=${group.duration.toFixed(6)}#segment.vtt`;
        lines.push(`#EXTINF:${group.duration.toFixed(6)},`, vttUrl);
      }

      lines.push('#EXT-X-ENDLIST', '');

      reply.header('Content-Type', 'application/vnd.apple.mpegurl');
      reply.status(200).send(lines.join('\n'));
    },
  );

  fastify.get(
    '/vtt-proxy',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The absolute subtitle URL' },
            referer: { type: 'string', description: 'The Referer header required by the CDN' },
            tsoffset: { type: 'string', description: 'First PTS of the video, in 90kHz ticks' },
            start: { type: 'string', description: 'Segment start on the programme timeline' },
            dur: { type: 'string', description: 'Segment length in seconds' },
          },
          required: ['url'],
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { url, referer, tsoffset, start, dur } = request.query as {
        url: string;
        referer?: string;
        tsoffset?: string;
        start?: string;
        dur?: string;
      };
      if (!url) return reply.status(400).send({ message: 'url is required' });

      try {
        const headers: Record<string, string> = {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        };
        if (referer) {
          try {
            const refUrl = new URL(referer);
            headers['Referer'] = `${refUrl.origin}/`;
            headers['Origin'] = refUrl.origin;
          } catch {
            headers['Referer'] = referer;
          }
        }

        let body = (await fetchTextCached(url, headers)).replace(/^﻿/, '');

        // Some of these sources hand back SRT under a .vtt name; its
        // comma-separated milliseconds have to become periods to parse.
        if (!body.startsWith('WEBVTT')) {
          body = `WEBVTT\n\n${body.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`;
        }

        // Cue times are relative to the start of the programme, but HLS reads
        // them against the MPEG-TS clock, which starts at an arbitrary PTS.
        // Without this mapping the cues are anchored to the wrong origin.
        const offset = Number(tsoffset) || 0;
        const header = `WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:${offset}`;

        // Serve only this segment's window when the playlist is segmented;
        // without a window, fall back to the whole track.
        let out: string;
        if (start !== undefined && dur !== undefined) {
          const from = Number(start) || 0;
          const cues = sliceVttCues(body, from, from + (Number(dur) || 0));
          out = `${header}\n\n${cues.join('\n\n')}\n`;
        } else {
          const firstBreak = body.indexOf('\n\n');
          out = `${header}\n${firstBreak === -1 ? '' : body.slice(firstBreak)}`;
        }

        reply.header('Content-Type', 'text/vtt; charset=utf-8');
        reply.status(200).send(out);
      } catch (err: any) {
        // A rendition segment that errors is not treated as "no subtitles" by
        // the player — it retries and can wedge playback. Serving an empty but
        // valid segment costs the captions for this window and keeps the video
        // running, which is the better failure.
        request.log?.warn?.(`vtt-proxy failed for ${url}: ${err.message}`);
        reply.header('Content-Type', 'text/vtt; charset=utf-8');
        reply
          .status(200)
          .send(`WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:${Number(tsoffset) || 0}\n\n`);
      }
    },
  );

  fastify.get(
    '/segment-proxy',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The absolute segment URL to proxy and decrypt' },
            referer: { type: 'string', description: 'The Referer header required by the CDN' },
          },
          required: ['url'],
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
    const { url, referer } = request.query as { url: string; referer?: string };
    if (!url) return reply.status(400).send({ message: 'url is required' });

    try {
      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      };
      if (referer) {
        try {
          const refUrl = new URL(referer);
          headers['Referer'] = `${refUrl.origin}/`;
          headers['Origin'] = refUrl.origin;
        } catch {
          headers['Referer'] = referer;
        }
      }

      // De-obfuscation needs the whole segment, so a Range request cannot be
      // forwarded upstream — every one would otherwise re-download several
      // megabytes. A seek issues a burst of them, which is what made this
      // expensive enough to time out.
      let buffer = getCachedSegment(url);
      if (!buffer) {
        const res = await axios.get(url, {
          headers,
          responseType: 'arraybuffer',
          // Segments here run to several megabytes; 15s was short enough that
          // a slow origin turned into a failed request, which AVPlayer
          // surfaces as "resource unavailable" and gives up on.
          timeout: 45000,
        });

        buffer = Buffer.from(res.data);
        const tsStart = findTransportStreamStart(buffer);
        if (tsStart > 0) {
          buffer = buffer.subarray(tsStart);
        } else if (tsStart < 0 && buffer.length > 70 && buffer.readUInt32BE(0) === 0x89504e47) {
          // Not a recognisable transport stream (an fMP4 segment would land
          // here); fall back to dropping just the PNG wrapper.
          buffer = buffer.subarray(70);
        }
        cacheSegment(url, buffer);
      }

      // iOS's AVPlayer issues Range requests when loading HLS segments and
      // expects a proper 206/Content-Range response — silently returning
      // 200 with the full body (as this endpoint always did) causes it to
      // hang indefinitely rather than error, since it never gets the
      // partial-content response it's waiting for. The de-obfuscation above
      // needs the complete upstream buffer, so range support is applied
      // ourselves after fetching the full file rather than forwarding the
      // client's Range header upstream.
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Content-Type', 'video/mp2t');

      const range = request.headers.range;
      const rangeMatch = range && /^bytes=(\d+)-(\d*)$/.exec(range);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        // A range starting past the end is unsatisfiable. Answering it with a
        // 206 and an empty body looks like a truncated resource.
        if (start >= buffer.length) {
          reply.header('Content-Range', `bytes */${buffer.length}`);
          reply.status(416).send();
          return;
        }

        // The end has to be clamped. Echoing back a larger end than the
        // resource has produces a Content-Range that contradicts the body,
        // and AVFoundation rejects the whole resource over it — which is
        // what a large seek was running into.
        const requestedEnd = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : buffer.length - 1;
        const end = Math.min(requestedEnd, buffer.length - 1);
        const chunk = buffer.subarray(start, end + 1);

        reply.header('Content-Range', `bytes ${start}-${end}/${buffer.length}`);
        reply.header('Content-Length', String(chunk.length));
        reply.status(206).send(chunk);
        return;
      }

      reply.header('Content-Length', String(buffer.length));
      reply.status(200).send(buffer);
    } catch (err: any) {
      // These failures are otherwise invisible: the player reports only
      // "resource unavailable" with no indication of which request died.
      request.log?.warn?.(
        `segment-proxy failed (${err.response?.status ?? err.code ?? 'error'}) for ${url}: ${err.message}`,
      );
      reply.status(502).send({ message: err.message });
    }
  });
};

export default routes;
