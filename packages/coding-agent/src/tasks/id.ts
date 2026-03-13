const CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LEN = 4;
const PREFIX = "t_";

/** Generate a random short task ID like `t_7kx3`. */
export function generateTaskId(): string {
	let id = PREFIX;
	for (let i = 0; i < ID_LEN; i++) {
		id += CHARSET[Math.floor(Math.random() * CHARSET.length)];
	}
	return id;
}
