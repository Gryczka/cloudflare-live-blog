import type { BlogCreationRateLimitDecision } from '../../durable-objects/BlogCreationRateLimiter';
import { hashIdentifier } from '../capability';

/** Reserve creation capacity without exposing the connecting IP to storage. */
export async function reserveBlogCreation(
	bindings: Env,
	connectingIp: string | null,
): Promise<BlogCreationRateLimitDecision> {
	if (!connectingIp) return 'unavailable';

	try {
		const identifierHash = await hashIdentifier(connectingIp);
		return await bindings.BLOG_CREATION_RATE_LIMITER.getByName(identifierHash).reserve();
	} catch {
		return 'unavailable';
	}
}
