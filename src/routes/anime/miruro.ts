import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { ANIME } from '@consumet/extensions';
import Redis from 'ioredis/built';
import { redis, REDIS_TTL } from '../../main';
import cache from '../../utils/cache';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  const miruro = new (ANIME as any).Miruro();

  const paginationSchema = {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          perPage: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
    },
  };

  fastify.get('/', (_: FastifyRequest, rp: FastifyReply) => {
    rp.status(200).send({
      intro: "Welcome to the miruro provider: check out the provider's website @ https://www.miruro.to/",
      routes: [
        '/instruction',
        '/:query',
        '/suggestions',
        '/info',
        '/episodes/:anilistId',
        '/watch/:episodeId',
        '/trending',
        '/popular',
        '/upcoming',
        '/recent',
        '/schedule',
        '/recommendations/:anilistId',
        '/spotlight',
        '/genre/:genre',
        '/year/:year',
        '/format/:format',
        '/status/:status',
        '/anime/:id/characters',
        '/anime/:id/relations',
      ],
      documentation: 'https://docs.consumet.org/',
    });
  });

  fastify.get('/instruction', async (request: FastifyRequest, reply: FastifyReply) => {
    reply.status(200).send({
      message: "To use the Miruro provider in production without facing Cloudflare WAF blocks, you must deploy a Python bypass helper.",
      instructions: [
        "1. Clone the Python bypass helper repository: https://github.com/solo12345689/Miruro-API",
        "2. Deploy the Python application on a VPS (Virtual Private Server) with a clean residential or non-datacenter IP range (Free cloud hosts like Render are blocked by Cloudflare's WAF).",
        "3. Set the environment variable in your Node.js application: MIRURO_PROXY_URL = <your-deployed-python-helper-url>",
        "4. If no MIRURO_PROXY_URL is set, it will default to http://127.0.0.1:8000 for local development."
      ],
      links: {
        repository: "https://github.com/solo12345689/Miruro-API"
      }
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
            page: { type: 'integer', minimum: 1, default: 1 },
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
              `miruro:search:${query}:${page}`,
              async () => await miruro.search(query, page),
              REDIS_TTL
            )
          : await miruro.search(query, page);

        reply.status(200).send(res);
      } catch (err: any) {
        console.error('Miruro route error:', err?.message || err);
        reply.status(500).send({
          message: err?.message || 'Something went wrong. Contact developer for help.',
        });
      }
    }
  );

  fastify.get(
    '/suggestions',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = (request.query as { query: string }).query;

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `miruro:suggestions:${query}`,
              async () => await miruro.fetchSuggestions(query),
              REDIS_TTL
            )
          : await miruro.fetchSuggestions(query);

        reply.status(200).send(res);
      } catch (err: any) {
        console.error('Miruro route error:', err?.message || err);
        reply.status(500).send({
          message: err?.message || 'Something went wrong. Contact developer for help.',
        });
      }
    }
  );

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
              `miruro:info:${id}`,
              async () => await miruro.fetchAnimeInfo(id),
              REDIS_TTL
            )
          : await miruro.fetchAnimeInfo(id);

        reply.status(200).send(res);
      } catch (err: any) {
        console.error('Miruro route error:', err?.message || err);
        reply.status(500).send({
          message: err?.message || 'Something went wrong. Contact developer for help.',
        });
      }
    }
  );

  fastify.get(
    '/episodes/:anilistId',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            anilistId: { type: 'integer' },
          },
          required: ['anilistId'],
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const anilistId = (request.params as { anilistId: number }).anilistId;

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `miruro:episodes:${anilistId}`,
              async () => await miruro.fetchEpisodesOnly(anilistId),
              REDIS_TTL
            )
          : await miruro.fetchEpisodesOnly(anilistId);

        reply.status(200).send(res);
      } catch (err: any) {
        console.error('Miruro route error:', err?.message || err);
        reply.status(500).send({
          message: err?.message || 'Something went wrong. Contact developer for help.',
        });
      }
    }
  );

  fastify.get('/watch/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const episodeId = (request.params as { '*': string })['*'];

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `miruro:watch:${episodeId}`,
            async () => await miruro.fetchEpisodeSources(episodeId),
            REDIS_TTL
          )
        : await miruro.fetchEpisodeSources(episodeId);

      reply.status(200).send(res);
    } catch (err: any) {
      console.error('Miruro route error:', err?.message || err);
      reply.status(500).send({
        message: err?.message || 'Something went wrong. Contact developer for help.',
      });
    }
  });

  fastify.get('/trending', paginationSchema, async (request: FastifyRequest, reply: FastifyReply) => {
    const { page, perPage } = request.query as { page: number; perPage: number };
    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `miruro:trending:${page}:${perPage}`,
            async () => await miruro.fetchTrending(page),
            REDIS_TTL
          )
        : await miruro.fetchTrending(page);

      reply.status(200).send(res);
    } catch (err: any) {
      console.error('Miruro route error:', err?.message || err);
      reply.status(500).send({
        message: err?.message || 'Something went wrong. Contact developer for help.',
      });
    }
  });

  fastify.get('/popular', paginationSchema, async (request: FastifyRequest, reply: FastifyReply) => {
    const { page, perPage } = request.query as { page: number; perPage: number };
    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `miruro:popular:${page}:${perPage}`,
            async () => await miruro.fetchPopular(page),
            REDIS_TTL
          )
        : await miruro.fetchPopular(page);

      reply.status(200).send(res);
    } catch (err: any) {
      console.error('Miruro route error:', err?.message || err);
      reply.status(500).send({
        message: err?.message || 'Something went wrong. Contact developer for help.',
      });
    }
  });

  fastify.get('/upcoming', paginationSchema, async (request: FastifyRequest, reply: FastifyReply) => {
    const { page, perPage } = request.query as { page: number; perPage: number };
    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `miruro:upcoming:${page}:${perPage}`,
            async () => await miruro.fetchUpcoming(page),
            REDIS_TTL
          )
        : await miruro.fetchUpcoming(page);

      reply.status(200).send(res);
    } catch (err: any) {
      console.error('Miruro route error:', err?.message || err);
      reply.status(500).send({
        message: err?.message || 'Something went wrong. Contact developer for help.',
      });
    }
  });

  fastify.get('/recent', paginationSchema, async (request: FastifyRequest, reply: FastifyReply) => {
    const { page, perPage } = request.query as { page: number; perPage: number };
    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `miruro:recent:${page}:${perPage}`,
            async () => await miruro.fetchRecent(page),
            REDIS_TTL
          )
        : await miruro.fetchRecent(page);

      reply.status(200).send(res);
    } catch (err: any) {
      console.error('Miruro route error:', err?.message || err);
      reply.status(500).send({
        message: err?.message || 'Something went wrong. Contact developer for help.',
      });
    }
  });

  fastify.get('/schedule', paginationSchema, async (request: FastifyRequest, reply: FastifyReply) => {
    const { page, perPage } = request.query as { page: number; perPage: number };
    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `miruro:schedule:${page}:${perPage}`,
            async () => await miruro.fetchSchedule(page),
            REDIS_TTL
          )
        : await miruro.fetchSchedule(page);

      reply.status(200).send(res);
    } catch (err: any) {
      console.error('Miruro route error:', err?.message || err);
      reply.status(500).send({
        message: err?.message || 'Something went wrong. Contact developer for help.',
      });
    }
  });

  fastify.get(
    '/recommendations/:anilistId',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            anilistId: { type: 'integer' },
          },
          required: ['anilistId'],
        },
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            perPage: { type: 'integer', minimum: 1, default: 15 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const anilistId = (request.params as { anilistId: number }).anilistId;
      const { page, perPage } = request.query as { page: number; perPage: number };

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `miruro:recommendations:${anilistId}:${page}:${perPage}`,
              async () => await miruro.fetchRecommendations(anilistId, page),
              REDIS_TTL
            )
          : await miruro.fetchRecommendations(anilistId, page);

        reply.status(200).send(res);
      } catch (err: any) {
        console.error('Miruro route error:', err?.message || err);
        reply.status(500).send({
          message: err?.message || 'Something went wrong. Contact developer for help.',
        });
      }
    }
  );

  fastify.get('/spotlight', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `miruro:spotlight`,
            async () => await miruro.fetchSpotlight(),
            REDIS_TTL
          )
        : await miruro.fetchSpotlight();

      reply.status(200).send(res);
    } catch (err: any) {
      console.error('Miruro route error:', err?.message || err);
      reply.status(500).send({
        message: err?.message || 'Something went wrong. Contact developer for help.',
      });
    }
  });

  // --- SEPARATE FILTERS ENDPOINTS ---

  fastify.get(
    '/genre/:genre',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            genre: { type: 'string' },
          },
          required: ['genre'],
        },
        ...paginationSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const genre = (request.params as { genre: string }).genre;
      const { page, perPage } = request.query as { page: number; perPage: number };

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `miruro:genre:${genre}:${page}:${perPage}`,
              async () => await miruro.fetchFilter({ genre, page, perPage }),
              REDIS_TTL
            )
          : await miruro.fetchFilter({ genre, page, perPage });

        reply.status(200).send(res);
      } catch (err: any) {
        console.error('Miruro route error:', err?.message || err);
        reply.status(500).send({
          message: err?.message || 'Something went wrong. Contact developer for help.',
        });
      }
    }
  );

  fastify.get(
    '/year/:year',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            year: { type: 'integer' },
          },
          required: ['year'],
        },
        ...paginationSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const year = (request.params as { year: number }).year;
      const { page, perPage } = request.query as { page: number; perPage: number };

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `miruro:year:${year}:${page}:${perPage}`,
              async () => await miruro.fetchFilter({ year, page, perPage }),
              REDIS_TTL
            )
          : await miruro.fetchFilter({ year, page, perPage });

        reply.status(200).send(res);
      } catch (err: any) {
        console.error('Miruro route error:', err?.message || err);
        reply.status(500).send({
          message: err?.message || 'Something went wrong. Contact developer for help.',
        });
      }
    }
  );

  fastify.get(
    '/format/:format',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['TV', 'MOVIE', 'OVA', 'ONA', 'SPECIAL', 'MUSIC'] },
          },
          required: ['format'],
        },
        ...paginationSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const format = (request.params as { format: string }).format;
      const { page, perPage } = request.query as { page: number; perPage: number };

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `miruro:format:${format}:${page}:${perPage}`,
              async () => await miruro.fetchFilter({ format, page, perPage }),
              REDIS_TTL
            )
          : await miruro.fetchFilter({ format, page, perPage });

        reply.status(200).send(res);
      } catch (err: any) {
        console.error('Miruro route error:', err?.message || err);
        reply.status(500).send({
          message: err?.message || 'Something went wrong. Contact developer for help.',
        });
      }
    }
  );

  fastify.get(
    '/status/:status',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['releasing', 'finished', 'not_yet_released', 'cancelled', 'hiatus'] },
          },
          required: ['status'],
        },
        ...paginationSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const status = (request.params as { status: string }).status;
      const { page, perPage } = request.query as { page: number; perPage: number };

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `miruro:status:${status}:${page}:${perPage}`,
              async () => await miruro.fetchFilter({ status, page, perPage }),
              REDIS_TTL
            )
          : await miruro.fetchFilter({ status, page, perPage });

        reply.status(200).send(res);
      } catch (err: any) {
        console.error('Miruro route error:', err?.message || err);
        reply.status(500).send({
          message: err?.message || 'Something went wrong. Contact developer for help.',
        });
      }
    }
  );

  // --- EXTRA METADATA ENDPOINTS ---

  fastify.get(
    '/anime/:id/characters',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
          },
          required: ['id'],
        },
        ...paginationSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = (request.params as { id: number }).id;
      const { page, perPage } = request.query as { page: number; perPage: number };

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `miruro:characters:${id}:${page}:${perPage}`,
              async () => await miruro.fetchCharacters(id, page, perPage),
              REDIS_TTL
            )
          : await miruro.fetchCharacters(id, page, perPage);

        reply.status(200).send(res);
      } catch (err: any) {
        console.error('Miruro route error:', err?.message || err);
        reply.status(500).send({
          message: err?.message || 'Something went wrong. Contact developer for help.',
        });
      }
    }
  );

  fastify.get(
    '/anime/:id/relations',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
          },
          required: ['id'],
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = (request.params as { id: number }).id;

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `miruro:relations:${id}`,
              async () => await miruro.fetchRelations(id),
              REDIS_TTL
            )
          : await miruro.fetchRelations(id);

        reply.status(200).send(res);
      } catch (err: any) {
        console.error('Miruro route error:', err?.message || err);
        reply.status(500).send({
          message: err?.message || 'Something went wrong. Contact developer for help.',
        });
      }
    }
  );

};

export default routes;
