import { handle } from '../server.mjs';

export default async function handler(request, response) {
  return handle(request, response);
}
