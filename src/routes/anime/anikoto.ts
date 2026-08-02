import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { ANIME } from '@consumet/extensions';
import { StreamingServers, SubOrSub } from '@consumet/extensions/dist/models';

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

  fastify.get('/:query', async (request: FastifyRequest, reply: FastifyReply) => {
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
    async (request: FastifyRequest, reply: FastifyReply) => {
      const episodeId = (request.params as { episodeId: string }).episodeId;
      const server = (request.query as { server: StreamingServers }).server;
      const category = (request.query as { category: SubOrSub }).category;

      if (typeof episodeId === 'undefined')
        return reply.status(400).send({ message: 'episodeId is required' });

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `anikoto:watch:${episodeId}:${server}:${category}`,
              async () => await anikoto.fetchEpisodeSources(episodeId, server, category),
              REDIS_TTL,
            )
          : await anikoto.fetchEpisodeSources(episodeId, server, category);

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

  fastify.get('/schedule', async (request: FastifyRequest, reply: FastifyReply) => {
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

  fastify.get('/download/:episodeId', async (request: FastifyRequest, reply: FastifyReply) => {
    const episodeId = (request.params as { episodeId: string }).episodeId;

    try {
      let res = await anikoto.fetchDownloadLinks(episodeId);
      reply.status(200).send(res);
    } catch (err) {
      reply.status(500).send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });
};

export default routes;
