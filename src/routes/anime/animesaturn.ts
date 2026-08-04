import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { ANIME } from '@consumet/extensions';
import Redis from 'ioredis/built';
import { redis, REDIS_TTL } from '../../main';
import cache from '../../utils/cache';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  const animesaturn = new ANIME.AnimeSaturn();

  fastify.get('/', (_, rp) => {
    rp.status(200).send({
      intro:
        "Welcome to the animesaturn provider: check out the provider's website @ https://www.animesaturn.tv/",
      routes: ['/:query', '/info/:id', '/watch/:episodeId'],
      documentation: 'https://docs.consumet.org/#tag/animesaturn',
    });
  });

  fastify.get('/:query', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.params as { query: string }).query;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `animesaturn:search:${query}`,
            async () => await animesaturn.search(query),
            REDIS_TTL,
          )
        : await animesaturn.search(query);

      reply.status(200).send(res);
    } catch (err: any) {
      console.error('AnimeSaturn route error:', err?.message || err);
      reply.status(500).send({
        message: err?.message || 'Something went wrong. Contact developer for help.',
      });
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
            `animesaturn:info:${id}`,
            async () => await animesaturn.fetchAnimeInfo(id),
            REDIS_TTL,
          )
        : await animesaturn.fetchAnimeInfo(id);

      reply.status(200).send(res);
    } catch (err) {
      console.error('AnimeSaturn route error:', err);
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

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
              `animesaturn:watch:${episodeId}`,
              async () => await animesaturn.fetchEpisodeSources(episodeId),
              REDIS_TTL,
            )
          : await animesaturn.fetchEpisodeSources(episodeId);

        reply.status(200).send(res);
      } catch (err) {
        console.error('AnimeSaturn route error:', err);
        reply
          .status(500)
          .send({ message: 'Something went wrong. Contact developer for help.' });
      }
    },
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
              `animesaturn:servers:${episodeId}`,
              async () => await animesaturn.fetchEpisodeServers(episodeId),
              REDIS_TTL,
            )
          : await animesaturn.fetchEpisodeServers(episodeId);

        reply.status(200).send(res);
      } catch (err) {
        console.error('AnimeSaturn route error:', err);
        reply
          .status(500)
          .send({ message: 'Something went wrong. Contact developer for help.' });
      }
    },
  );
};

export default routes;
