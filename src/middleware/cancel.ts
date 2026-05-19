import type { FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../lib/logger.js';

/**
 * Bind an AbortController to the underlying socket. Aborts only when the
 * client disconnects BEFORE the response is fully sent. We watch the socket
 * (not `req.raw`) because Fastify has already consumed the request body by
 * the time the handler runs — its 'close' event would fire spuriously.
 *
 * Cleanup is wired to `reply.raw` 'finish' (response fully flushed) and
 * 'close' (socket gone). Both remove the listener so post-response socket
 * close does not retroactively abort.
 */
export function bindCancelController(req: FastifyRequest, reply: FastifyReply): AbortController {
  const controller = new AbortController();
  const socket = req.raw.socket;
  if (!socket) {
    logger.warn({ url: req.url }, 'no underlying socket — client cancel detection disabled');
    return controller;
  }

  let responded = false;
  const onSocketClose = () => {
    if (!responded && !controller.signal.aborted) controller.abort();
  };
  socket.once('close', onSocketClose);

  const cleanup = () => {
    responded = true;
    socket.removeListener('close', onSocketClose);
  };
  reply.raw.once('finish', cleanup);
  reply.raw.once('close', cleanup);

  return controller;
}
