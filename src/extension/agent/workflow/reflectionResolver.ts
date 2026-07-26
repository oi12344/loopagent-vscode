import type { SubagentResult, SubagentRoleId } from "./types";
import type { DependencyResolver, DynamicNodeConfig, DynamicNodeId } from "./dynamicGraphTypes";

export type ReflectionVerdict = {
	approved: boolean;
	/** Carried into the next round's revise-node prompt via inputMapping, alongside the raw review content. */
	feedback?: string;
};

export type ReflectionResolverOptions = {
	/** Hard cap on revise/review round-trips; also bounded transitively by the engine's own maxDepth. */
	maxRounds: number;
	judge: (reviewResult: SubagentResult) => ReflectionVerdict;
	reviseTask: (round: number, verdict: ReflectionVerdict, reviewResult: SubagentResult) => string;
	reviewTask: (round: number) => string;
	reviseRole?: SubagentRoleId;
	reviewRole?: SubagentRoleId;
	idPrefix?: string;
};

/**
 * Builds a self-perpetuating pair of resolvers implementing an execute -> review -> revise loop
 * without a real cycle in the graph: each round is a fresh pair of nodes, so maxDepth caps the
 * number of rounds the same way it caps any other dependency chain. Register the returned
 * resolver under the id of the FIRST review node (round 1); it registers the matching revise/review
 * resolver for every subsequent round it creates, so callers never touch `resolvers` again.
 *
 * Because resolveDependencies() gives every node returned from one resolver call the SAME single
 * dependency (the node currently resolving), a round's revise and review nodes cannot be created
 * in the same call -- the review resolver creates only the revise node, and a resolver registered
 * for that revise node creates only the next review node.
 */
export function createReflectionResolver(
	resolvers: Map<DynamicNodeId, DependencyResolver>,
	options: ReflectionResolverOptions,
): DependencyResolver {
	const prefix = options.idPrefix ?? "reflect";

	function reviseResolver(round: number): DependencyResolver {
		return async (nodeId) => {
			const reviewId = `${prefix}-review-${round}`;
			resolvers.set(reviewId, reviewResolver(round));
			return [
				{
					id: reviewId,
					task: options.reviewTask(round),
					role: options.reviewRole,
					inputMapping: { revision: `${nodeId}.content` },
				},
			];
		};
	}

	function reviewResolver(round: number): DependencyResolver {
		return async (nodeId, completedNodes) => {
			const reviewResult = completedNodes.get(nodeId);
			if (!reviewResult) return [];

			const verdict = options.judge(reviewResult);
			if (verdict.approved || round >= options.maxRounds) return [];

			const nextRound = round + 1;
			const reviseId = `${prefix}-revise-${nextRound}`;
			resolvers.set(reviseId, reviseResolver(nextRound));

			const reviseConfig: DynamicNodeConfig = {
				id: reviseId,
				task: options.reviseTask(nextRound, verdict, reviewResult),
				role: options.reviseRole,
				inputMapping: { previousReview: `${nodeId}.content` },
			};
			return [reviseConfig];
		};
	}

	return reviewResolver(1);
}
