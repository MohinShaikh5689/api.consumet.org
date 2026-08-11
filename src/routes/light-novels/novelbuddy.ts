import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { LIGHT_NOVELS } from '@consumet/extensions';

import cache from '../../utils/cache';
import { redis, REDIS_TTL } from '../../main';
import { Redis } from 'ioredis';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  const novelbuddy = new (LIGHT_NOVELS as any).NovelBuddy();

  fastify.get('/', (_, rp) => {
    rp.status(200).send({
      intro: `Welcome to the NovelBuddy provider: check out the provider's website @ https://novelbuddy.me`,
      routes: ['/:query', '/info', '/read'],
    });
  });

  fastify.get('/:query', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.params as { query: string }).query;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `novelbuddy:search:${query}`,
            async () => await novelbuddy.search(query),
            REDIS_TTL,
          )
        : await novelbuddy.search(query);

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
            id: { type: 'string', description: 'The novel series slug (e.g. cultivation-online)' },
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
              `novelbuddy:info:${id}`,
              async () => await novelbuddy.fetchLightNovelInfo(id),
              REDIS_TTL,
            )
          : await novelbuddy.fetchLightNovelInfo(id);

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
            chapterId: { type: 'string', description: 'The chapter ID path (e.g. cultivation-online/chapter-1-cultivation-online)' },
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
              `novelbuddy:read:${chapterId}`,
              async () => await novelbuddy.fetchChapterContent(chapterId),
              REDIS_TTL,
            )
          : await novelbuddy.fetchChapterContent(chapterId);

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
