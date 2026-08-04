import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { PROVIDERS_LIST } from '@consumet/extensions';

import animeworld from './animeworld';
import anikoto from './anikoto';
import reanime from './reanime';
import animesaturn from './animesaturn';
import gogoanime from './gogoanime';
import miruro from './miruro';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  await fastify.register(animeworld, { prefix: '/animeworld' });
  await fastify.register(anikoto, { prefix: '/anikoto' });
  await fastify.register(reanime, { prefix: '/reanime' });
  await fastify.register(animesaturn, { prefix: '/animesaturn' });
  await fastify.register(gogoanime, { prefix: '/gogoanime' });
  await fastify.register(miruro, { prefix: '/miruro' });

  fastify.get('/', async (request: any, reply: any) => {
    reply.status(200).send('Welcome to Consumet Anime 🗾');
  });

  fastify.get('/:animeProvider', async (request: FastifyRequest, reply: FastifyReply) => {
    const queries: { animeProvider: string; page: number } = {
      animeProvider: '',
      page: 1,
    };

    queries.animeProvider = decodeURIComponent(
      (request.params as { animeProvider: string; page: number }).animeProvider,
    );

    queries.page = (request.query as { animeProvider: string; page: number }).page;

    if (queries.page! < 1) queries.page = 1;

    const provider = PROVIDERS_LIST.ANIME.find(
      (provider: any) => provider.toString.name === queries.animeProvider,
    );

    try {
      if (provider) {
        reply.redirect(`/anime/${provider.toString.name}`);
      } else {
        reply
          .status(404)
          .send({ message: 'Provider not found, please check the providers list.' });
      }
    } catch (err) {
      reply.status(500).send('Something went wrong. Please try again later.');
    }
  });
};

export default routes;
