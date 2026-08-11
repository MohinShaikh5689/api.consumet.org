import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { LIGHT_NOVELS } from '@consumet/extensions';

import cache from '../../utils/cache';
import { redis, REDIS_TTL } from '../../main';
import { Redis } from 'ioredis';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  const novelfire = new (LIGHT_NOVELS as any).NovelFire();

  fastify.get('/', (_, rp) => {
    rp.status(200).send({
      intro: `Welcome to the Novel Fire provider: check out the provider's website @ https://novelfire.net`,
      routes: ['/:query', '/info', '/read'],
    });
  });

  fastify.get('/:query', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.params as { query: string }).query;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `novelfire:search:${query}`,
            async () => await novelfire.search(query),
            REDIS_TTL,
          )
        : await novelfire.search(query);

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
              `novelfire:info:${id}`,
              async () => await novelfire.fetchLightNovelInfo(id),
              REDIS_TTL,
            )
          : await novelfire.fetchLightNovelInfo(id);

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
            chapterId: { type: 'string', description: 'The chapter ID path (e.g. cultivation-online/chapter-1)' },
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
              `novelfire:read:${chapterId}`,
              async () => await novelfire.fetchChapterContent(chapterId),
              REDIS_TTL,
            )
          : await novelfire.fetchChapterContent(chapterId);

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
