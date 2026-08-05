import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { ANIME } from '@consumet/extensions';
import Redis from 'ioredis/built';
import { redis, REDIS_TTL } from '../../main';
import cache from '../../utils/cache';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  const reanime = new (ANIME as any).ReAnime();

  fastify.get('/', (_, rp) => {
    rp.status(200).send({
      intro: "Welcome to the reanime provider: check out the provider's website @ https://reanime.to/",
      routes: ['/instruction', '/:query', '/info', '/watch/:episodeId', '/servers/:episodeId', '/schedule', '/latest', '/top'],
      documentation: 'https://docs.consumet.org/',
    });
  });

  fastify.get('/instruction', async (request: FastifyRequest, reply: FastifyReply) => {
    reply.status(200).send({
      message: "To use the ReAnime provider in production without facing Cloudflare WAF blocks, you must deploy the application on a VPS (Virtual Private Server) with a clean residential or non-datacenter IP range.",
      instructions: [
        "1. Free-tier cloud hosting providers (such as Render, Vercel, or Railway) use datacenter IP ranges that are heavily blocked by Cloudflare's WAF, resulting in HTTP 403 errors.",
        "2. Running the application locally using a residential IP range bypasses these blocks automatically.",
        "3. In production, host the Consumet API instance on a VPS with a clean, dedicated non-datacenter IP address to prevent 403 Forbidden responses."
      ]
    });
  });

  fastify.get('/schedule', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `reanime:schedule`,
            async () => await reanime.fetchSchedule(),
            REDIS_TTL
          )
        : await reanime.fetchSchedule();

      reply.status(200).send(res);
    } catch (err: any) {
      console.error('ReAnime route error:', err?.message || err);
      reply.status(500).send({
        message: err?.message || 'Something went wrong. Contact developer for help.',
      });
    }
  });

  fastify.get('/latest', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `reanime:latest`,
            async () => await reanime.fetchLatestEpisodes(),
            REDIS_TTL
          )
        : await reanime.fetchLatestEpisodes();

      reply.status(200).send(res);
    } catch (err: any) {
      console.error('ReAnime route error:', err?.message || err);
      reply.status(500).send({
        message: err?.message || 'Something went wrong. Contact developer for help.',
      });
    }
  });

  fastify.get(
    '/top',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['day', 'week', 'month'], default: 'week' },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { period, limit } = request.query as { period?: string; limit?: number };

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `reanime:top:${period}:${limit}`,
              async () => await reanime.fetchTopAnime(period, limit),
              REDIS_TTL
            )
          : await reanime.fetchTopAnime(period, limit);

        reply.status(200).send(res);
      } catch (err: any) {
        console.error('ReAnime route error:', err?.message || err);
        reply.status(500).send({
          message: err?.message || 'Something went wrong. Contact developer for help.',
        });
      }
    }
  );

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
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = (request.params as { query: string }).query;

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `reanime:search:${query}`,
              async () => await reanime.search(query),
              REDIS_TTL
            )
          : await reanime.search(query);

        reply.status(200).send(res);
      } catch (err: any) {
        console.error('ReAnime route error:', err?.message || err);
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
              `reanime:info:${id}`,
              async () => await reanime.fetchAnimeInfo(id),
              REDIS_TTL
            )
          : await reanime.fetchAnimeInfo(id);

        reply.status(200).send(res);
      } catch (err: any) {
        console.error('ReAnime route error:', err?.message || err);
        reply.status(500).send({
          message: err?.message || 'Something went wrong. Contact developer for help.',
        });
      }
    }
  );

  fastify.get(
    '/watch/*',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            '*': { type: 'string', description: 'episodeId' },
          },
          required: ['*'],
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const episodeId = (request.params as { '*': string })['*'];

      if (!episodeId)
        return reply.status(400).send({ message: 'episodeId is required' });

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `reanime:watch:${episodeId}`,
              async () => await reanime.fetchEpisodeSources(episodeId),
              REDIS_TTL
            )
          : await reanime.fetchEpisodeSources(episodeId);

        reply.status(200).send(res);
      } catch (err: any) {
        console.error('ReAnime route error:', err?.message || err);
        reply.status(500).send({
          message: err?.message || 'Something went wrong. Contact developer for help.',
        });
      }
    }
  );

  fastify.get(
    '/servers/*',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            '*': { type: 'string', description: 'episodeId' },
          },
          required: ['*'],
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const episodeId = (request.params as { '*': string })['*'];

      if (!episodeId)
        return reply.status(400).send({ message: 'episodeId is required' });

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `reanime:servers:${episodeId}`,
              async () => await reanime.fetchEpisodeServers(episodeId),
              REDIS_TTL
            )
          : await reanime.fetchEpisodeServers(episodeId);

        reply.status(200).send(res);
      } catch (err: any) {
        console.error('ReAnime route error:', err?.message || err);
        reply.status(500).send({
          message: err?.message || 'Something went wrong. Contact developer for help.',
        });
      }
    }
  );
};

export default routes;
