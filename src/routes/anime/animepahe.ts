import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { ANIME } from '@consumet/extensions';

import cache from '../../utils/cache';
import { redis, REDIS_TTL } from '../../main';
import { Redis } from 'ioredis';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  const animepahe = new ANIME.AnimePahe();

  // Root
  fastify.get('/', async (_, reply) => {
    reply.status(200).send({
      intro: `Welcome to the animepahe provider`,
      routes: ['/:query', '/info/:id', '/watch?episodeId=', '/recent-episodes?page='],
      documentation: 'https://docs.consumet.org/#tag/animepahe',
    });
  });

  // Search
  fastify.get('/:query', {
    schema: {
      params: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {

    const query = (request.params as { query: string }).query;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `animepahe:search:${query}`,
            async () => await animepahe.search(query),
            REDIS_TTL,
          )
        : await animepahe.search(query);

      reply.status(200).send(res);
    } catch {
      reply.status(500).send({ message: 'Something went wrong.' });
    }
  });

  // Recent Episodes
  fastify.get('/recent-episodes', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'number', default: 1 }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {

    const page = (request.query as { page?: number }).page || 1;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `animepahe:recent-episodes:${page}`,
            async () => await animepahe.fetchRecentEpisodes(page),
            REDIS_TTL,
          )
        : await animepahe.fetchRecentEpisodes(page);

      reply.status(200).send(res);
    } catch {
      reply.status(500).send({ message: 'Something went wrong.' });
    }
  });

  // Anime Info
  fastify.get('/info/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          episodePage: { type: 'number', default: 1 }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {

    const id = decodeURIComponent((request.params as { id: string }).id);
    const episodePage = (request.query as { episodePage?: number }).episodePage || 1;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `animepahe:info:${id}:${episodePage}`,
            async () => await animepahe.fetchAnimeInfo(id, episodePage),
            REDIS_TTL,
          )
        : await animepahe.fetchAnimeInfo(id, episodePage);

      reply.status(200).send(res);
    } catch {
      reply.status(500).send({ message: 'Something went wrong.' });
    }
  });

  // Watch Episode
  fastify.get('/watch', {
    schema: {
      querystring: {
        type: 'object',
        required: ['episodeId'],
        properties: {
          episodeId: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest, reply: FastifyReply) => {

    const episodeId = (request.query as { episodeId: string }).episodeId;

    if (!episodeId)
      return reply.status(400).send({ message: 'episodeId is required' });

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `animepahe:watch:${episodeId}`,
            async () => await animepahe.fetchEpisodeSources(episodeId),
            REDIS_TTL,
          )
        : await animepahe.fetchEpisodeSources(episodeId);

      reply.status(200).send(res);
    } catch (err) {
      console.log(err);
      reply.status(500).send({ message: 'Something went wrong.' });
    }
  });
};

export default routes;
