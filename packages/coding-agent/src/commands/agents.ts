/**
 * Manage bundled task agents.
 */
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { type AgentsAction, type AgentsCommandArgs, runAgentsCommand } from "../cli/agents-cli";
import { initTheme } from "../modes/theme/theme";

const ACTIONS: AgentsAction[] = ["unpack"];

export default class Agents extends Command {
	static description = "Manage bundled task agents";

	static args = {
		action: Args.string({
			description: "Agents action",
			required: false,
			options: ACTIONS,
		}),
	};

	static flags = {
		force: Flags.boolean({ char: "f", description: "Overwrite existing agent files" }),
		json: Flags.boolean({ description: "Output JSON" }),
		dir: Flags.string({ description: "Output directory (overrides --user/--project)" }),
		user: Flags.boolean({ description: "Write to ~/.oh-omp/agent/agents (default)" }),
		project: Flags.boolean({ description: "Write to ./.oh-omp/agents" }),
	};

	static examples = [
		"# Export bundled agents into user config (default)\n  oh-omp agents unpack",
		"# Export bundled agents into project config\n  oh-omp agents unpack --project",
		"# Overwrite existing local agent files\n  oh-omp agents unpack --project --force",
		"# Export into a custom directory\n  oh-omp agents unpack --dir ./tmp/agents --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Agents);
		if (!args.action) {
			renderCommandHelp("oh-omp", "agents", Agents);
			return;
		}

		const cmd: AgentsCommandArgs = {
			action: args.action as AgentsAction,
			flags: {
				force: flags.force,
				json: flags.json,
				dir: flags.dir,
				user: flags.user,
				project: flags.project,
			},
		};

		await initTheme();
		await runAgentsCommand(cmd);
	}
}
