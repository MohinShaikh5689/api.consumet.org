import { FastifyInstance, RegisterOptions } from 'fastify';

import novelbuddy from './novelbuddy';
import chikari from './chikari';
import novelfire from './novelfire';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  await fastify.register(novelbuddy, { prefix: '/novelbuddy' });
  await fastify.register(chikari, { prefix: '/chikari' });
  await fastify.register(novelfire, { prefix: '/novelfire' });

  fastify.get('/', async (request: any, reply: any) => {
    reply.status(200).send('Welcome to Consumet Light Novels 📚');
  });
};

export default routes;
