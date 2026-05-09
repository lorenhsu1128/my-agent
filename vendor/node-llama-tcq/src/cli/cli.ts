#!/usr/bin/env node

// M-LOCAL-MODEL-ROBUSTNESS-B4：bun on Windows 對 mkdir(...{recursive:true}) 已存在
// dir 仍會 throw EEXIST（node spec 應 silent no-op）。fs-extra mkdirp / ensureDir、
// proper-lockfile、cmake-js wrapper 等多處受影響，逐點 try/catch 不可行。
// 在 process 進入點 monkey-patch 一次：把 mkdir 對「目錄已存在」的 EEXIST
// 自動 swallow，其他錯誤照丟。只在 win32 + bun 啟用，避免污染 node 生產路徑。
import "../utils/bunWindowsMkdirShim.js";

import {fileURLToPath} from "url";
import path from "path";
import yargs from "yargs";
import {hideBin} from "yargs/helpers";
import fs from "fs-extra";
import {cliBinName, documentationPageUrls} from "../config.js";
import {setIsRunningFromCLI} from "../state.js";
import {withCliCommandDescriptionDocsUrl} from "./utils/withCliCommandDescriptionDocsUrl.js";
import {PullCommand} from "./commands/PullCommand.js";
import {ChatCommand} from "./commands/ChatCommand.js";
import {InitCommand} from "./commands/InitCommand.js";
import {SourceCommand} from "./commands/source/SourceCommand.js";
import {CompleteCommand} from "./commands/CompleteCommand.js";
import {InfillCommand} from "./commands/InfillCommand.js";
import {InspectCommand} from "./commands/inspect/InspectCommand.js";
import {OnPostInstallCommand} from "./commands/OnPostInstallCommand.js";
import {DebugCommand} from "./commands/DebugCommand.js";
import {ServerCommand} from "./commands/ServerCommand.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const packageJson = fs.readJSONSync(path.join(__dirname, "..", "..", "package.json"));

setIsRunningFromCLI(true);

const yarg = yargs(hideBin(process.argv));

yarg
    .scriptName(cliBinName)
    .usage(withCliCommandDescriptionDocsUrl("Usage: $0 <command> [options]", documentationPageUrls.CLI.index))
    .command(PullCommand)
    .command(ChatCommand)
    .command(InitCommand)
    .command(SourceCommand)
    .command(CompleteCommand)
    .command(InfillCommand)
    .command(InspectCommand)
    .command(OnPostInstallCommand)
    .command(DebugCommand)
    .command(ServerCommand)
    .recommendCommands()
    .demandCommand(1)
    .strict()
    .strictCommands()
    .alias("v", "version")
    .help("h")
    .alias("h", "help")
    .version(packageJson.version)
    .wrap(Math.min(130, yarg.terminalWidth()))
    .parse();
