import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { ANIME } from '@consumet/extensions';

import cache from '../../utils/cache';
import { redis, REDIS_TTL } from '../../main';
import { Redis } from 'ioredis';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  const gogoanime = new (ANIME as any).GogoAnime();

  fastify.get('/', (_, rp) => {
    rp.status(200).send({
      intro: `Welcome to the gogoanime provider: check out the provider's website @ ${gogoanime.toString.baseUrl}`,
      routes: ['/:query', '/info', '/watch/:episodeId'],
      documentation: 'https://docs.consumet.org/#tag/gogoanime',
    });
  });

  fastify.get('/:query', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.params as { query: string }).query;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `gogoanime:search:${query}`,
            async () => await gogoanime.search(query),
            REDIS_TTL,
          )
        : await gogoanime.search(query);

      reply.status(200).send(res);
    } catch (err: any) {
      console.error('GogoAnime route error:', err?.message || err);
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
            `gogoanime:info:${id}`,
            async () => await gogoanime.fetchAnimeInfo(id),
            REDIS_TTL,
          )
        : await gogoanime.fetchAnimeInfo(id);

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

      if (typeof episodeId === 'undefined')
        return reply.status(400).send({ message: 'episodeId is required' });

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `gogoanime:watch:${episodeId}`,
              async () => await gogoanime.fetchEpisodeSources(episodeId),
              REDIS_TTL,
            )
          : await gogoanime.fetchEpisodeSources(episodeId);

        reply.status(200).send(res);
      } catch (err) {
        reply
          .status(500)
          .send({ message: 'Something went wrong. Contact developer for help.' });
      }
    },
  );
};

export default routes;
