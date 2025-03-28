// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams } from 'child_process';
import { spawn } from 'cross-spawn';
import { readFile } from 'fs/promises';
import * as path from 'path';
import { WebSocket } from 'ws';

const vscodeVariables = require('vscode-variables');

let resolveContentPreviewProvider: (value: ContentPreviewProvider) => void = () => { };
let contentPreviewProvider = new Promise<ContentPreviewProvider>(resolve => {
	resolveContentPreviewProvider = resolve;
});

let resolveOutlineProvider: (value: OutlineProvider) => void = () => { };
let outlineProvider = new Promise<OutlineProvider>(resolve => {
	resolveOutlineProvider = resolve;
});

type ScrollSyncMode = "never" | "onSelectionChange";

async function loadHTMLFile(context: vscode.ExtensionContext, relativePath: string) {
	const filePath = path.resolve(context.extensionPath, relativePath);
	const fileContents = await readFile(filePath, 'utf8');
	return fileContents;
}

function statusBarItemProcess(event: "Compiling" | "CompileSuccess" | "CompileError") {
	const style = vscode.workspace.getConfiguration().get<string>('typst-preview.statusBarIndicator') || "compact";
	if (statusBarItem) {
		if (event === "Compiling") {
			if (style === "compact") {
				statusBarItem.text = "$(sync~spin)";
			} else if (style === "full") {
				statusBarItem.text = "$(sync~spin) Compiling";
			}
			statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.prominentBackground");
			statusBarItem.show();
		} else if (event === "CompileSuccess") {
			if (style === "compact") {
				statusBarItem.text = "$(typst-guy)";
			} else if (style === "full") {
				statusBarItem.text = "$(typst-guy) Compile Success";
			}
			statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.prominentBackground");
			statusBarItem.show();
		} else if (event === "CompileError") {
			if (style === "compact") {
				statusBarItem.text = "$(typst-guy)";
			} else if (style === "full") {
				statusBarItem.text = "$(typst-guy) Compile Error";
			}
			statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
			statusBarItem.show();
		}
	}
}

export async function getCliPath(extensionPath?: string): Promise<string> {
	const state = getCliPath as unknown as any;
	(!state.BINARY_NAME) && (state.BINARY_NAME = "typst-preview");
	(!state.getConfig) && (state.getConfig = (
		() => vscode.workspace.getConfiguration().get<string>('typst-preview.executable')));

	const bundledPath = path.resolve(extensionPath || path.join(__dirname, ".."), "out", state.BINARY_NAME);
	const configPath = state.getConfig();

	if (state.bundledPath === bundledPath && state.configPath === configPath) {
		// console.log('getCliPath cached', state.resolved);
		return state.resolved;
	}
	state.bundledPath = bundledPath;
	state.configPath = configPath;

	const executableExists = (path: string) => {
		return new Promise(resolve => {
			try {
				const spawnRet = spawn(path, ['--help'], {
					timeout: 1000, /// 1 second
				});
				spawnRet.on('error', () => resolve(false));
				spawnRet.on('exit', (code: number) => resolve(code === 0));
			} catch {
				resolve(false);
			}
		});
	};

	const resolvePath = async () => {
		console.log('getCliPath resolving', bundledPath, configPath);

		if (configPath?.length) {
			return configPath;
		}

		if (await executableExists(bundledPath)) {
			return bundledPath;
		}

		vscode.window.showWarningMessage(
			`${state.BINARY_NAME} executable at ${bundledPath} not working,` +
			`maybe we didn't ship it for your platform or it cannot run due to library issues?` +
			`In this case you need compile and add ${state.BINARY_NAME} to your PATH.`);
		return state.BINARY_NAME;
	};

	return (state.resolved = await resolvePath());
}

export function getCliFontArgs(fontPaths?: string[]): string[] {
	return (fontPaths ?? []).flatMap((fontPath) => ["--font-path", vscodeVariables(fontPath)]);
}

export function codeGetCliFontArgs(): string[] {
	return getCliFontArgs(vscode.workspace.getConfiguration().get<string[]>(
		'typst-preview.fontPaths'));
}

function getProjectRoot(currentPath: string): string {
	const checkIfPathContains = (base: string, target: string) => {
		const relativePath = path.relative(base, target);
		return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
	};
	const paths = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath).filter(folder => checkIfPathContains(folder, currentPath));
	if (!paths || paths.length === 0) {
		// return path's parent folder
		return path.dirname(currentPath);
	} else {
		return paths[0];
	}
}

const serverProcesses: Array<any> = [];
const activeTask = new Map<vscode.TextDocument, TaskControlBlock>();

// If there is only one preview task, we treat the workspace as a multi-file project,
// so `Sync preview with cursor` command in any file goes to the unique preview server.
//
// If there are more then one preview task, we assume user is previewing serval single file
// document, only process sync command directly happened in those file.
//
// This is a compromise we made to support multi-file projects after evaluating performance,
// effectiveness, and user needs.
// See https://github.com/Enter-tainer/typst-preview/issues/164 for more detail.
const reportPosition = async (bindDocument: vscode.TextDocument, activeEditor: vscode.TextEditor, event: string) => {
	let tcb = activeTask.get(bindDocument);
	if (tcb === undefined) {
		if (activeTask.size === 1) {
			tcb = Array.from(activeTask.values())[0];
		} else {
			return;
		}
	}
	const { addonΠserver } = tcb;
	const scrollRequest = {
		event,
		'filepath': bindDocument.uri.fsPath,
		'line': activeEditor.selection.active.line,
		'character': activeEditor.selection.active.character,
	};
	console.log(scrollRequest);
	addonΠserver.send(JSON.stringify(scrollRequest));
};

interface TaskControlBlock {
	/// related panel
	panel?: vscode.WebviewPanel;
	/// channel to communicate with typst-preview
	addonΠserver: WebSocket;
}

interface JumpInfo {
	filepath: string,
	start: [number, number] | null,
	end: [number, number] | null,
}

async function editorScrollTo(activeEditor: vscode.TextEditor, jump: JumpInfo) {
	console.log("recv editorScrollTo request", jump);
	if (jump.start === null || jump.end === null) {
		return;
	}

	// open this file and show in editor
	const doc = await vscode.workspace.openTextDocument(jump.filepath);
	const editor = await vscode.window.showTextDocument(doc, activeEditor.viewColumn);
	const startPosition = new vscode.Position(jump.start[0], jump.start[1]);
	const endPosition = new vscode.Position(jump.end[0], jump.end[1]);
	const range = new vscode.Range(startPosition, endPosition);
	editor.selection = new vscode.Selection(range.start, range.end);
	editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

function syncEditorChanges(addonΠserver: WebSocket) {
	console.log("recv syncEditorChanges request");
	let files: Record<string, string> = {};
	vscode.workspace.textDocuments.forEach((doc) => {
		if (doc.isDirty) {
			files[doc.fileName] = doc.getText();
		}
	});

	addonΠserver.send(JSON.stringify({
		event: "syncMemoryFiles",
		files,
	}));
}

interface LaunchCliResult {
	serverProcess: ChildProcessWithoutNullStreams,
	controlPlanePort: string,
	dataPlanePort: string,
	staticFilePort?: string,
}

function runServer(command: string, args: string[], outputChannel: vscode.OutputChannel, openInBrowser: boolean): Promise<LaunchCliResult> {
	const serverProcess = spawn(command, args, {
		env: {
			...process.env,
			// eslint-disable-next-line @typescript-eslint/naming-convention
			"RUST_BACKTRACE": "1",
		}
	});
	serverProcess.on('error', (err: any) => {
		console.error('Failed to start server process');
		vscode.window.showErrorMessage(`Failed to start typst-preview(${command}) process: ${err}`);
	});
	serverProcess.stdout.on('data', (data: Buffer) => {
		outputChannel.append(data.toString());
	});
	serverProcess.stderr.on('data', (data: Buffer) => {
		outputChannel.append(data.toString());
	});
	serverProcess.on('exit', async (code: any) => {
		if (code !== null && code !== 0) {
			const response = await vscode.window.showErrorMessage(`typst-preview process exited with code ${code}`, "Show Logs");
			if (response === "Show Logs") {
				outputChannel.show();
			}
		}
		console.log(`child process exited with code ${code}`);
	});

	serverProcesses.push(serverProcesses);
	return new Promise((resolve, reject) => {
		let dataPlanePort: string | undefined = undefined;
		let controlPlanePort: string | undefined = undefined;
		let staticFilePort: string | undefined = undefined;
		serverProcess.stderr.on('data', (data: Buffer) => {
			if (data.toString().includes("listening on")) {
				console.log(data.toString());
				let ctrlPort = data.toString().match(/Control plane server listening on: 127\.0\.0\.1:(\d+)/)?.[1];
				let dataPort = data.toString().match(/Data plane server listening on: 127\.0\.0\.1:(\d+)/)?.[1];
				let staticPort = data.toString().match(/Static file server listening on: 127\.0\.0\.1:(\d+)/)?.[1];
				if (ctrlPort !== undefined) {
					controlPlanePort = ctrlPort;
				}
				if (dataPort !== undefined) {
					dataPlanePort = dataPort;
				}
				if (staticPort !== undefined) {
					staticFilePort = staticPort;
				}
				if (dataPlanePort !== undefined && controlPlanePort !== undefined) {
					if (openInBrowser) {
						if (staticFilePort !== undefined) {
							resolve({ dataPlanePort, controlPlanePort, staticFilePort, serverProcess });
						}
					} else {
						resolve({ dataPlanePort, controlPlanePort, serverProcess });
					}
				}
			}
		});
	});
}

interface LaunchTask {
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
	activeEditor: vscode.TextEditor,
	bindDocument: vscode.TextDocument,
	mode: 'doc' | 'slide',
}

interface LaunchInBrowserTask extends LaunchTask {
	kind: 'browser',
}

interface LaunchInWebViewTask extends LaunchTask {
	kind: 'webview',
}

const launchPreview = async (task: LaunchInBrowserTask | LaunchInWebViewTask) => {
	let shadowDispose: vscode.Disposable | undefined = undefined;
	let shadowDisposeClose: vscode.Disposable | undefined = undefined;
	const {
		context,
		outputChannel,
		activeEditor,
		bindDocument,
	} = task;
	const filePath = bindDocument.uri.fsPath;

	const refreshStyle = vscode.workspace.getConfiguration().get<string>('typst-preview.refresh') || "onSave";
	const scrollSyncMode = vscode.workspace.getConfiguration().get<ScrollSyncMode>('typst-preview.scrollSync') || "never";
	const enableCursor = vscode.workspace.getConfiguration().get<boolean>('typst-preview.cursorIndicator') || false;
	const fontendPath = path.resolve(context.extensionPath, "out/frontend");
	await watchEditorFiles();
	const { serverProcess, controlPlanePort, dataPlanePort } = await launchCli(task.kind === 'browser');

	const addonΠserver = new WebSocket(`ws://127.0.0.1:${controlPlanePort}`);
	addonΠserver.addEventListener("message", async (message) => {
		const data = JSON.parse(message.data as string);
		switch (data.event) {
			case "editorScrollTo": return await editorScrollTo(activeEditor, data /* JumpInfo */);
			case "syncEditorChanges": return syncEditorChanges(addonΠserver);
			case "compileStatus": {
				statusBarItemProcess(data.kind);
				break;
			}
			case "outline": {
				contentPreviewProvider.then((p) => p.postOutlineItem(data /* Outline */));
				outlineProvider.then((p) => p.postOutlineItem(data /* Outline */));
				break;
			}
			default: {
				console.warn("unknown message", data);
				break;
			}
		}
	});

	if (enableCursor) {
		addonΠserver.addEventListener("open", () => {
			reportPosition(bindDocument, activeEditor, 'changeCursorPosition');
		});
	}

	// See comment of reportPosition function to get context about multi-file project related logic.
	const src2docHandler = (e: vscode.TextEditorSelectionChangeEvent) => {
		if (e.textEditor === activeEditor || activeTask.size === 1) {
			const editor = e.textEditor === activeEditor ? activeEditor : e.textEditor;
			const doc = e.textEditor === activeEditor ? bindDocument : e.textEditor.document;

			const kind = e.kind;
			console.log(`selection changed, kind: ${kind && vscode.TextEditorSelectionChangeKind[kind]}`);
			if (kind === vscode.TextEditorSelectionChangeKind.Mouse) {
				console.log(`selection changed, sending src2doc jump request`);
				reportPosition(doc, editor, 'panelScrollTo');
			}

			if (enableCursor) {
				reportPosition(doc, editor, 'changeCursorPosition');
			}
		}
	};
	const src2docHandlerDispose =
		scrollSyncMode === "onSelectionChange"
			? vscode.window.onDidChangeTextEditorSelection(src2docHandler, 500)
			: undefined;

	serverProcess.on('exit', (code: any) => {
		addonΠserver.close();
		if (activeTask.has(bindDocument)) {
			activeTask.delete(bindDocument);
		}
		src2docHandlerDispose?.dispose();
		shadowDispose?.dispose();
		shadowDisposeClose?.dispose();
	});

	let connectUrl = `ws://127.0.0.1:${dataPlanePort}`;
	contentPreviewProvider.then((p) => p.postActivate(connectUrl));
	switch (task.kind) {
		case 'browser': return launchPreviewInBrowser();
		case 'webview': return launchPreviewInWebView();
	}

	async function launchPreviewInBrowser() {
		// todo: may override the same file
		activeTask.set(bindDocument, {
			addonΠserver,
		});
	}

	async function launchPreviewInWebView() {
		const basename = path.basename(activeEditor.document.fileName);
		// Create and show a new WebView
		const panel = vscode.window.createWebviewPanel(
			'typst-preview', // 标识符
			`${basename} (Preview)`, // 面板标题
			vscode.ViewColumn.Beside, // 显示在编辑器的哪一侧
			{
				enableScripts: true, // 启用 JS
				retainContextWhenHidden: true,
			}
		);

		panel.onDidDispose(async () => {
			// todo: bindDocument.onDidDispose, but we did not find a similar way.
			activeTask.delete(bindDocument);
			serverProcess.kill();
			contentPreviewProvider.then((p) => p.postDeactivate(connectUrl));
			console.log('killed preview services');
			panel.dispose();
		});

		// 将已经准备好的 HTML 设置为 Webview 内容
		let html = await loadHTMLFile(context, "./out/frontend/index.html");
		html = html.replace(
			/\/typst-webview-assets/g,
			`${panel.webview
				.asWebviewUri(vscode.Uri.file(fontendPath))
				.toString()}/typst-webview-assets`
		);
		const previewMode = task.mode === 'doc' ? "Doc" : "Slide";
		html = html.replace(
			"preview-arg:previewMode:Doc",
			`preview-arg:previewMode:${previewMode}`
		);
		panel.webview.html = html.replace("ws://127.0.0.1:23625", `ws://127.0.0.1:${dataPlanePort}`);
		// 虽然配置的是 http，但是如果是桌面客户端，任何 tcp 连接都支持，这也就包括了 ws
		// https://code.visualstudio.com/api/advanced-topics/remote-extensions#forwarding-localhost
		await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${dataPlanePort}`));
		activeTask.set(bindDocument, {
			panel,
			addonΠserver,
		});
	};

	async function watchEditorFiles() {
		if (refreshStyle === "onType") {
			console.log('watch editor changes');

			shadowDispose = vscode.workspace.onDidChangeTextDocument(async (e) => {
				if (e.document.uri.scheme === "file") {
					// console.log("... ", "updateMemoryFiles", e.document.fileName);
					addonΠserver.send(JSON.stringify({
						event: "updateMemoryFiles",
						files: {
							[e.document.fileName]: e.document.getText(),
						},
					}));
				}

			});
			shadowDisposeClose = vscode.workspace.onDidSaveTextDocument(async (e) => {
				if (e.uri.scheme === "file") {
					console.log("... ", "saveMemoryFiles", e.fileName);
					addonΠserver.send(JSON.stringify({
						event: "removeMemoryFiles",
						files: [e.fileName],
					}));
				}
			});
		}
	};

	async function launchCli(openInBrowser: boolean) {
		const serverPath = await getCliPath(context.extensionPath);
		console.log(`Watching ${filePath} for changes`);
		const projectRoot = getProjectRoot(filePath);
		const rootArgs = ["--root", projectRoot];
		const partialRenderingArgs = vscode.workspace.getConfiguration().get<boolean>('typst-preview.partialRendering') ? ["--partial-rendering"] : [];
		const previewInSlideModeArgs = task.mode === 'slide' ? ["--preview-mode=slide"] : [];
		const { dataPlanePort, controlPlanePort, staticFilePort, serverProcess } = await runServer(serverPath, [
			"--data-plane-host", "127.0.0.1:0",
			"--control-plane-host", "127.0.0.1:0",
			"--static-file-host", "127.0.0.1:0",
			"--no-open",
			...rootArgs,
			...partialRenderingArgs,
			...previewInSlideModeArgs,
			...codeGetCliFontArgs(),
			filePath,
		], outputChannel, openInBrowser);
		console.log(`Launched server, data plane port:${dataPlanePort}, control plane port:${controlPlanePort}`);
		if (openInBrowser) {
			vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${staticFilePort}`));
		}
		// window.typstWebsocket.send("current");
		return {
			serverProcess, dataPlanePort, controlPlanePort
		};
	};
};

class ContentPreviewProvider implements vscode.WebviewViewProvider {

	private _view?: vscode.WebviewView;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly extensionUri: vscode.Uri,
		private readonly htmlContent: string,
	) { }

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;// 将已经准备好的 HTML 设置为 Webview 内容

		const fontendPath = path.resolve(this.context.extensionPath, "out/frontend");
		let html = this.htmlContent.replace(
			/\/typst-webview-assets/g,
			`${this._view.webview.asWebviewUri(vscode.Uri.file(fontendPath))
				.toString()}/typst-webview-assets`
		);

		html = html.replace("ws://127.0.0.1:23625", ``);

		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,

			localResourceRoots: [
				this.extensionUri
			]
		};

		webviewView.webview.html = html;

		webviewView.webview.onDidReceiveMessage(data => {
			switch (data.type) {
				case 'started': // on content preview restarted
					{
						this.resetHost();
						break;
					}
			}
		});
	}

	resetHost() {
		if (this._view && this.current) {
			console.log('postActivateSent', this.current);
			this._view.webview.postMessage(this.current);
		}
		if (this._view && this.currentOutline) {
			this._view.webview.postMessage(this.currentOutline);
			this.currentOutline = undefined;
		}
	};

	current: any = undefined;
	postActivate(url: string) {
		this.current = {
			type: 'reconnect',
			url,
			mode: "Doc",
			isContentPreview: true,
		};
		this.resetHost();
	}

	postDeactivate(url: string) {
		if (this.current && this.current.url === url) {
			this.currentOutline = undefined;
			this.postActivate('');
		}
	}

	currentOutline: any = undefined;
	postOutlineItem(outline: any) {
		this.currentOutline = {
			type: 'outline',
			outline,
			isContentPreview: true,
		};
		if (this._view) {
			this._view.webview.postMessage(this.currentOutline);
			this.currentOutline = undefined;
		}
	}
}

// todo: useful content security policy but we don't set
// Use a nonce to only allow a specific script to be run.
// const nonce = getNonce();

// function getNonce() {
// 	let text = '';
// 	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// 	for (let i = 0; i < 32; i++) {
// 		text += possible.charAt(Math.floor(Math.random() * possible.length));
// 	}
// 	return text;
// }

// <!--
// Use a content security policy to only allow loading styles from our extension directory,
// and only allow scripts that have a specific nonce.
// (See the 'webview-sample' extension sample for img-src content security policy examples)
// -->
// <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">

interface CursorPosition {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	page_no: number,
	x: number,
	y: number,
}

interface OutlineItemData {
	title: string,
	position?: CursorPosition,
	children: OutlineItemData[],
}

class OutlineProvider implements vscode.TreeDataProvider<OutlineItem> {
	constructor(
		private readonly _extensionUri: vscode.Uri,
	) { }


	private _onDidChangeTreeData: vscode.EventEmitter<OutlineItem | undefined | void> = new vscode.EventEmitter<OutlineItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<OutlineItem | undefined | void> = this._onDidChangeTreeData.event;

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	outline: { items: OutlineItemData[] } | undefined = undefined;
	postOutlineItem(outline: any) {
		console.log('postOutlineItemProvider', outline);
		this.outline = outline;
		this.refresh();
	}

	getTreeItem(element: OutlineItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: OutlineItem): Thenable<OutlineItem[]> {
		if (!this.outline) {
			vscode.window.showInformationMessage('No dependency in empty workspace');
			return Promise.resolve([]);
		}

		const children = (element ? element.data.children : this.outline.items) || [];
		return Promise.resolve(children.map((item: OutlineItemData) => {
			return new OutlineItem(item, item.children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed :
				vscode.TreeItemCollapsibleState.None);
		}));
	}
}

export class OutlineItem extends vscode.TreeItem {

	constructor(
		public readonly data: OutlineItemData,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly command?: vscode.Command
	) {
		super(data.title, collapsibleState);

		const pos = this.data.position;
		if (pos) {
			this.tooltip = `${this.label} in page ${pos.page_no}, at (${pos.x.toFixed(3)} pt, ${pos.y.toFixed(3)} pt)`;
			this.description = `page: ${pos.page_no}, at (${pos.x.toFixed(1)} pt, ${pos.y.toFixed(1)} pt)`;
		} else {
			this.tooltip = `${this.label}`;
			this.description = `no pos`;
		}
	}

	// iconPath = {
	// 	light: path.join(__filename, '..', '..', 'resources', 'light', 'dependency.svg'),
	// 	dark: path.join(__filename, '..', '..', 'resources', 'dark', 'dependency.svg')
	// };

	contextValue = 'outline-item';
}

let statusBarItem: vscode.StatusBarItem;
// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
// todo: is global state safe?
export function activate(context: vscode.ExtensionContext) {
	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const outputChannel = vscode.window.createOutputChannel('typst-preview');
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
	statusBarItem.name = 'typst-preview';
	statusBarItem.command = 'typst-preview.showLog';
	statusBarItem.tooltip = 'Typst Preview Status: Click to show logs';

	// https://github.com/microsoft/vscode-extension-samples/blob/4721ef0c450f36b5bce2ecd5be4f0352ed9e28ab/webview-view-sample/src/extension.ts#L3
	let contentPreviewHtml = loadHTMLFile(context, "./out/frontend/index.html");
	contentPreviewHtml.then(html => {
		const provider = new ContentPreviewProvider(context, context.extensionUri, html);
		resolveContentPreviewProvider(provider);
		context.subscriptions.push(
			vscode.window.registerWebviewViewProvider('typst-preview.content-preview', provider));
	});
	{
		const outlineProvider = new OutlineProvider(context.extensionUri);
		resolveOutlineProvider(outlineProvider);
		context.subscriptions.push(
			vscode.window.registerTreeDataProvider('typst-preview.outline', outlineProvider));
	}

	let webviewDisposable = vscode.commands.registerCommand('typst-preview.preview', launchPrologue('webview', 'doc'));
	let browserDisposable = vscode.commands.registerCommand('typst-preview.browser', launchPrologue('browser', 'doc'));
	let webviewSlideDisposable = vscode.commands.registerCommand('typst-preview.preview-slide', launchPrologue('webview', 'slide'));
	let browserSlideDisposable = vscode.commands.registerCommand('typst-preview.browser-slide', launchPrologue('browser', 'slide'));
	let syncDisposable = vscode.commands.registerCommand('typst-preview.sync', async () => {
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) {
			vscode.window.showWarningMessage('No active editor');
			return;
		}

		reportPosition(activeEditor.document, activeEditor, 'panelScrollTo');
	});
	let showLogDisposable = vscode.commands.registerCommand('typst-preview.showLog', async () => {
		outputChannel.show();
	});

	context.subscriptions.push(webviewDisposable, browserDisposable, webviewSlideDisposable, browserSlideDisposable, syncDisposable, showLogDisposable, statusBarItem);
	process.on('SIGINT', () => {
		for (const serverProcess of serverProcesses) {
			serverProcess.kill();
		}
	});

	function launchPrologue(kind: 'browser' | 'webview', mode: 'doc' | 'slide') {
		return async () => {
			const activeEditor = vscode.window.activeTextEditor;
			if (!activeEditor) {
				vscode.window.showWarningMessage('No active editor');
				return;
			}
			const bindDocument = activeEditor.document;
			launchPreview({
				kind,
				context,
				outputChannel,
				activeEditor,
				bindDocument,
				mode,
			});
		};
	};
}

// This method is called when your extension is deactivated
export async function deactivate() {
	console.log(activeTask);
	for (const [_, task] of activeTask) {
		task.panel?.dispose();
	}
	console.log('killing preview services');
	for (const serverProcess of serverProcesses) {
		serverProcess.kill();
	}
}
