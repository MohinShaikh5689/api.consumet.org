import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { LIGHT_NOVELS } from '@consumet/extensions';

import cache from '../../utils/cache';
import { redis, REDIS_TTL } from '../../main';
import { Redis } from 'ioredis';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  const chikari = new (LIGHT_NOVELS as any).Chikari();

  fastify.get('/', (_, rp) => {
    rp.status(200).send({
      intro: `Welcome to the Chikari provider: check out the provider's website @ https://chikari.moe`,
      routes: ['/:query', '/info', '/read'],
    });
  });

  fastify.get('/:query', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.params as { query: string }).query;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `chikari:search:${query}`,
            async () => await chikari.search(query),
            REDIS_TTL,
          )
        : await chikari.search(query);

      reply.status(200).send(res);
    } catch (err: any) {
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
            id: { type: 'string', description: 'The novel series slug (e.g. shadow-slave)' },
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
              `chikari:info:${id}`,
              async () => await chikari.fetchLightNovelInfo(id),
              REDIS_TTL,
            )
          : await chikari.fetchLightNovelInfo(id);

        reply.status(200).send(res);
      } catch (err: any) {
        reply.status(500).send({
          message: err?.message || 'Something went wrong. Contact developer for help.',
        });
      }
    }
  );

  fastify.get(
    '/read',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            chapterId: { type: 'string', description: 'The chapter ID path (e.g. shadow-slave/1)' },
          },
          required: ['chapterId'],
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const chapterId = (request.query as { chapterId: string }).chapterId;

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `chikari:read:${chapterId}`,
              async () => await chikari.fetchChapterContent(chapterId),
              REDIS_TTL,
            )
          : await chikari.fetchChapterContent(chapterId);

        reply.status(200).send(res);
      } catch (err: any) {
        reply.status(500).send({
          message: err?.message || 'Something went wrong. Contact developer for help.',
        });
      }
    }
  );
};

export default routes;
