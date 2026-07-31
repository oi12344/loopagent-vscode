import type { StateWrite, WorkflowStateSnapshot } from "./dynamicGraphTypes";

export class StateWriteConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StateWriteConflictError";
	}
}

export type WorkflowStateStore = {
	readSnapshot(): WorkflowStateSnapshot;
	commitWrites(snapshot: WorkflowStateSnapshot, writes: readonly StateWrite[]): WorkflowStateSnapshot;
};

export function createWorkflowState(
	initialValues: Readonly<Record<string, unknown>> = {},
	initialSnapshot?: WorkflowStateSnapshot,
): WorkflowStateStore {
	let current: WorkflowStateSnapshot = initialSnapshot
		? { step: initialSnapshot.step, version: initialSnapshot.version, values: new Map(initialSnapshot.values) }
		: {
			step: 0,
			version: 0,
			values: new Map(Object.entries(initialValues)),
		};

	return {
		readSnapshot: () => current,
		commitWrites(snapshot, writes) {
			if (snapshot.version !== current.version) {
				throw new StateWriteConflictError(`Stale workflow snapshot (${snapshot.version}/${current.version})`);
			}

			const ordered = [...writes].sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.channel.localeCompare(b.channel));
			const byChannel = new Map<string, StateWrite[]>();
			for (const write of ordered) {
				const existing = byChannel.get(write.channel) ?? [];
				existing.push(write);
				byChannel.set(write.channel, existing);
			}

			const nextValues = new Map(current.values);
			for (const [channel, channelWrites] of byChannel) {
				const modes = new Set(channelWrites.map((write) => write.mode));
				if (modes.size > 1) throw new StateWriteConflictError(`Mixed reducers for channel '${channel}'`);
				const mode = channelWrites[0].mode;
				switch (mode) {
					case "single":
						if (channelWrites.length > 1) throw new StateWriteConflictError(`Multiple writers for channel '${channel}'`);
						nextValues.set(channel, channelWrites[0].value);
						break;
					case "append": {
						const previous = nextValues.get(channel);
						if (previous !== undefined && !Array.isArray(previous)) throw new StateWriteConflictError(`Channel '${channel}' is not appendable`);
						nextValues.set(channel, [...(Array.isArray(previous) ? previous : []), ...channelWrites.map((write) => write.value)]);
						break;
					}
					case "merge": {
						const merged = isRecord(nextValues.get(channel)) ? { ...nextValues.get(channel) as Record<string, unknown> } : {};
						for (const write of channelWrites) {
							if (!isRecord(write.value)) throw new StateWriteConflictError(`Channel '${channel}' expects object writes`);
							for (const [key, value] of Object.entries(write.value)) {
								if (Object.prototype.hasOwnProperty.call(merged, key)) throw new StateWriteConflictError(`Conflicting field '${channel}.${key}'`);
								merged[key] = value;
							}
						}
						nextValues.set(channel, merged);
						break;
					}
				}
			}

			current = { step: current.step + 1, version: current.version + 1, values: nextValues };
			return current;
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
