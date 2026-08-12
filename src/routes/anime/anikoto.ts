import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { ANIME } from '@consumet/extensions';
import { StreamingServers, SubOrSub } from '@consumet/extensions/dist/models';
import axios from 'axios';

import cache from '../../utils/cache';
import { redis, REDIS_TTL } from '../../main';
import { Redis } from 'ioredis';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  const anikoto = new ANIME.AniKoto();

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

      const { data } = await axios.get(url, { headers });
      const hostUrl = `${request.protocol}://${request.hostname}`;
      
      const lines = data.split('\n');
      const rewrittenLines = lines.map((line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        
        if (trimmed.startsWith('#')) {
          return line;
        }
        
        let absoluteUrl = trimmed;
        if (!trimmed.startsWith('http')) {
          absoluteUrl = new URL(trimmed, url).href;
        }
        
        if (trimmed.includes('.m3u8')) {
          return `${hostUrl}/anime/anikoto/m3u8-proxy?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(referer || '')}`;
        }
        
        return `${hostUrl}/anime/anikoto/segment-proxy?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(referer || '')}`;
      });

      reply.header('Content-Type', 'application/vnd.apple.mpegurl');
      reply.header('Accept-Ranges', 'bytes');
      reply.status(200).send(rewrittenLines.join('\n'));
    } catch (err: any) {
      reply.status(500).send({ message: err.message });
    }
  });

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

      const res = await axios.get(url, {
        headers,
        responseType: 'arraybuffer',
        timeout: 15000
      });
      
      let buffer = Buffer.from(res.data);
      if (buffer.length > 70 && buffer.readUInt32BE(0) === 0x89504E47) {
        buffer = buffer.subarray(70);
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
        const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : buffer.length - 1;
        const chunk = buffer.subarray(start, end + 1);
        reply.header('Content-Range', `bytes ${start}-${end}/${buffer.length}`);
        reply.header('Content-Length', String(chunk.length));
        reply.status(206).send(chunk);
        return;
      }

      reply.header('Content-Length', String(buffer.length));
      reply.status(200).send(buffer);
    } catch (err: any) {
      reply.status(500).send({ message: err.message });
    }
  });
};

export default routes;
