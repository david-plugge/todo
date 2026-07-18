// Hybrid Logical Clock — a sortable timestamp that stays close to wall time but
// still preserves causal order across devices with skewed clocks. Every change
// carries one; string comparison of the packed form == (millis, counter, node)
// order, so field-level last-write-wins is just `a.hlc > b.hlc`.
//
// Packed form: <48-bit millis, 12 hex><-><16-bit counter, 4 hex><-><nodeId>
// Fixed-width millis/counter make lexicographic string order match numeric order.

const NODE_KEY = 'todo.hlc.node';
const STATE_KEY = 'todo.hlc.state';

let millis = 0;
let counter = 0;
let loaded = false;

function nodeId(): string {
	let n = localStorage.getItem(NODE_KEY);
	if (!n) {
		n = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
		localStorage.setItem(NODE_KEY, n);
	}
	return n;
}

function load(): void {
	if (loaded) return;
	const s = localStorage.getItem(STATE_KEY);
	if (s) {
		const [m, c] = s.split(':');
		millis = Number(m) || 0;
		counter = Number(c) || 0;
	}
	loaded = true;
}

function save(): void {
	localStorage.setItem(STATE_KEY, `${millis}:${counter}`);
}

function pack(m: number, c: number): string {
	return `${m.toString(16).padStart(12, '0')}-${c.toString(16).padStart(4, '0')}-${nodeId()}`;
}

export function unpack(hlc: string): { millis: number; counter: number; node: string } {
	const [m, c, node] = hlc.split('-');
	return { millis: parseInt(m, 16), counter: parseInt(c, 16), node: node ?? '' };
}

/** Stamp a locally-generated change. */
export function send(): string {
	load();
	const pt = Date.now();
	if (pt > millis) {
		millis = pt;
		counter = 0;
	} else {
		counter++;
	}
	save();
	return pack(millis, counter);
}

/** Advance our clock past a change we received, preserving causality. */
export function recv(remote: string): void {
	load();
	const pt = Date.now();
	const { millis: rm, counter: rc } = unpack(remote);
	const newMillis = Math.max(millis, rm, pt);
	if (newMillis === millis && newMillis === rm) counter = Math.max(counter, rc) + 1;
	else if (newMillis === millis) counter = counter + 1;
	else if (newMillis === rm) counter = rc + 1;
	else counter = 0;
	millis = newMillis;
	save();
}

export function getNodeId(): string {
	return nodeId();
}
