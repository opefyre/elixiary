import { createFetchHandler } from './router.js';
import { createRateLimiter } from './rateLimit.js';
import { createListCache } from './cache.js';
import { createIndexService } from './index/service.js';

const listCache = createListCache();
const rateLimiter = createRateLimiter();
const indexService = createIndexService({ listCache });

const fetchHandler = createFetchHandler({
  rateLimiter,
  handleList: indexService.handleList,
  handlePost: indexService.handlePost,
  getIndex: indexService.getIndex,
  serializeRow: indexService.serializeRow
});

export default {
  fetch: fetchHandler
};

export { createOriginMatcher, createCorsHeaders } from './router.js';
