require('dotenv').config();

import Redis from 'ioredis';
import Fastify from 'fastify';
import FastifyCors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import fs from 'fs';
import chalk from 'chalk';

import books from './routes/books';
import anime from './routes/anime';
import manga from './routes/manga';
import comics from './routes/comics';
import lightnovels from './routes/light-novels';
import movies from './routes/movies';
import meta from './routes/meta';
import news from './routes/news';
import Utils from './utils';

export const redis =
  process.env.REDIS_HOST &&
  new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    password: process.env.REDIS_PASSWORD,
  });

// Default TTL 1 hour
export const REDIS_TTL = Number(process.env.REDIS_TTL) || 3600;

const fastify = Fastify({
  maxParamLength: 1000,
  logger: true,
});

export const tmdbApi = process.env.TMDB_KEY && process.env.TMDB_KEY;

(async () => {
  const PORT = Number(process.env.PORT) || 3000;

  await fastify.register(FastifyCors, {
    origin: '*',
    methods: ['GET'],
  });

  /**
   * ---------------------------
   * Swagger Documentation Setup
   * ---------------------------
   */
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'Consumet API',
        description: 'Self-hosted Consumet API documentation',
        version: '1.0.0',
      },
    },
  });

  await fastify.register(swaggerUI, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
  });

  /**
   * ---------------------------
   * DEMO MODE
   * ---------------------------
   */
  if (process.env.NODE_ENV === 'DEMO') {
    console.log(chalk.yellowBright('DEMO MODE ENABLED'));

    const map = new Map<string, { expiresIn: Date }>();
    const sessionDuration = 1000 * 60 * 60 * 5;

    fastify.addHook('onRequest', async (request, reply) => {
      const ip = request.ip;
      const session = map.get(ip);

      if (session) {
        const { expiresIn } = session;
        if (Date.now() > expiresIn.getTime()) {
          map.delete(ip);
          return reply.redirect('/apidemo');
        }

        if (request.url === '/apidemo') return reply.redirect('/');
        return;
      }

      if (request.url === '/apidemo') return;
      reply.redirect('/apidemo');
    });

    fastify.post('/apidemo', async (request, reply) => {
      const { ip } = request;
      if (map.get(ip)) return reply.redirect('/');

      const expiresIn = new Date(Date.now() + sessionDuration);
      map.set(ip, { expiresIn });

      reply.redirect('/');
    });

    fastify.get('/apidemo', async (_, reply) => {
      try {
        const stream = fs.readFileSync(__dirname + '/../demo/apidemo.html');
        return reply.type('text/html').send(stream);
      } catch (err) {
        return reply.status(500).send({
          message: 'Could not load demo page.',
        });
      }
    });

    setInterval(() => {
      const now = Date.now();
      for (const [ip, session] of map.entries()) {
        if (now > session.expiresIn.getTime()) {
          map.delete(ip);
        }
      }
    }, 1000 * 60 * 60);
  }

  /**
   * ---------------------------
   * Server Startup Logs
   * ---------------------------
   */
  console.log(chalk.green(`Starting server on port ${PORT}... 🚀`));

  if (!process.env.REDIS_HOST) {
    console.warn(chalk.yellowBright('Redis not found. Cache disabled.'));
  } else {
    console.log(
      chalk.green(`Redis connected. Default Cache TTL: ${REDIS_TTL} seconds`)
    );
  }

  if (!process.env.TMDB_KEY) {
    console.warn(
      chalk.yellowBright(
        'TMDB api key not found. TMDB meta route may not work.'
      )
    );
  }

  /**
   * ---------------------------
   * Route Registration
   * ---------------------------
   */
  await fastify.register(books, { prefix: '/books' });
  await fastify.register(anime, { prefix: '/anime' });
  await fastify.register(manga, { prefix: '/manga' });
  await fastify.register(comics, { prefix: '/comics' });
  await fastify.register(lightnovels, { prefix: '/light-novels' });
  await fastify.register(movies, { prefix: '/movies' });
  await fastify.register(meta, { prefix: '/meta' });
  await fastify.register(news, { prefix: '/news' });
  await fastify.register(Utils, { prefix: '/utils' });

  /**
   * ---------------------------
   * Root + 404
   * ---------------------------
   */
  fastify.get('/', (_, reply) => {
    reply.status(200).send(
      `Welcome to consumet api! 🎉`
    );
  });

  fastify.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: 'Page not found',
    });
  });

  /**
   * ---------------------------
   * Start Server
   * ---------------------------
   */
  try {
    fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
      if (err) throw err;
      console.log(`Server listening at ${address}`);
      console.log(`Swagger docs available at ${address}/docs`);
    });
  } catch (err: any) {
    fastify.log.error(err);
    process.exit(1);
  }
})();

/**
 * Vercel / Serverless Handler
 */
export default async function handler(req: any, res: any) {
  await fastify.ready();
  fastify.server.emit('request', req, res);
}
