import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { MarkdownKanbanParser, KanbanBoard, KanbanTask, KanbanColumn } from './markdownParser';

export class KanbanWebviewPanel {
    public static currentPanel: KanbanWebviewPanel | undefined;
    public static readonly viewType = 'markdownKanbanPanel';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _context: vscode.ExtensionContext;
    private _disposables: vscode.Disposable[] = [];
    private _board?: KanbanBoard;
    private _document?: vscode.TextDocument;
    private _htmlInitialized = false;
    private _lastSelfSaveTime = 0;

    public get documentUri(): vscode.Uri | undefined {
        return this._document?.uri;
    }

    public static createOrShow(extensionUri: vscode.Uri, context: vscode.ExtensionContext, document?: vscode.TextDocument) {
        const column = vscode.window.activeTextEditor?.viewColumn;

        if (KanbanWebviewPanel.currentPanel) {
            KanbanWebviewPanel.currentPanel._panel.reveal(column);
            if (document) {
                KanbanWebviewPanel.currentPanel.loadMarkdownFile(document);
            }
            return;
        }

        // Include workspace folders in localResourceRoots so images can load
        const resourceRoots: vscode.Uri[] = [extensionUri];
        if (vscode.workspace.workspaceFolders) {
            resourceRoots.push(...vscode.workspace.workspaceFolders.map(f => f.uri));
        }

        const panel = vscode.window.createWebviewPanel(
            KanbanWebviewPanel.viewType,
            'Markdown Kanban',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: resourceRoots,
                retainContextWhenHidden: true
            }
        );

        KanbanWebviewPanel.currentPanel = new KanbanWebviewPanel(panel, extensionUri, context);

        if (document) {
            KanbanWebviewPanel.currentPanel.loadMarkdownFile(document);
        }
    }

    public static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        const resourceRoots: vscode.Uri[] = [extensionUri];
        if (vscode.workspace.workspaceFolders) {
            resourceRoots.push(...vscode.workspace.workspaceFolders.map(f => f.uri));
        }
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: resourceRoots,
        };
        KanbanWebviewPanel.currentPanel = new KanbanWebviewPanel(panel, extensionUri, context);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._context = context;

        this._update();
        this._setupEventListeners();
        
        if (this._document) {
            this.loadMarkdownFile(this._document);
        }
    }

    private _setupEventListeners() {
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // retainContextWhenHidden preserves the webview DOM on tab switch.
        // File changes are handled by onDidChangeTextDocument in extension.ts.
        // No onDidChangeViewState handler needed — avoids redundant re-renders.

        this._panel.webview.onDidReceiveMessage(
            message => this._handleMessage(message),
            null,
            this._disposables
        );
    }

    private _handleMessage(message: any) {
        switch (message.type) {
            case 'moveTask':
                this.moveTask(message.taskId, message.fromColumnId, message.toColumnId, message.newIndex);
                break;
            case 'addTask':
                this.addTask(message.columnId, message.taskData);
                break;
            case 'deleteTask':
                this.deleteTask(message.taskId, message.columnId);
                break;
            case 'editTask':
                this.editTask(message.taskId, message.columnId, message.taskData);
                break;
            case 'addColumn':
                this.addColumn(message.title);
                break;
            case 'moveColumn':
                this.moveColumn(message.fromIndex, message.toIndex);
                break;
            case 'toggleTask':
                this.toggleTaskExpansion(message.taskId);
                break;
            case 'updateTaskStep':
                this.updateTaskStep(message.taskId, message.columnId, message.stepIndex, message.completed);
                break;
            case 'updateChecklistItem':
                this.updateChecklistItem(message.taskId, message.columnId, message.listKey, message.stepIndex, message.completed);
                break;
            case 'reorderTaskSteps':
                this.reorderTaskSteps(message.taskId, message.columnId, message.newOrder);
                break;
            case 'toggleColumnArchive':
                this.toggleColumnArchive(message.columnId, message.archived);
                break;
            case 'pasteImage':
                this.handlePasteImage(message.imageData, message.extension || 'png');
                break;
            case 'requestBoard':
                this._sendBoardData();
                break;
            case 'openFile':
                if (this._document && message.path) {
                    const docDir = path.dirname(this._document.uri.fsPath);
                    const filePath = path.resolve(docDir, message.path);
                    if (fs.existsSync(filePath)) {
                        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
                    }
                }
                break;
        }
    }

    public loadMarkdownFile(document: vscode.TextDocument) {
        // Skip re-parsing when the file change originated from our own save (within 1.5s).
        // Re-parsing generates new random task IDs which breaks the detail modal.
        // IMPORTANT: Don't reassign this._document here — it would point to the wrong file
        // if a different markdown editor triggers this during the guard window.
        if (Date.now() - this._lastSelfSaveTime < 1500) {
            return;
        }

        this._document = document;

        try {
            this._board = MarkdownKanbanParser.parseMarkdown(document.getText());
        } catch (error) {
            console.error('Error parsing Markdown:', error);
            vscode.window.showErrorMessage(`Kanban parsing error: ${error instanceof Error ? error.message : String(error)}`);
            this._board = { title: 'Error Loading Board', columns: [], nextId: 1 };
        }
        this._update();
    }

    private _update() {
        if (!this._panel.webview) return;

        // Only set HTML once — subsequent updates just send data via postMessage.
        // Replacing HTML on every change destroys modal state and causes race conditions.
        if (!this._htmlInitialized) {
            this._panel.webview.html = this._getHtmlForWebview();
            this._htmlInitialized = true;
        }

        this._sendBoardData();
    }

    private _sendBoardData() {
        const board = this._board || { title: 'Please open a Markdown Kanban file', columns: [] };

        // Resolve workspace URI for image rendering in descriptions
        let workspaceUri = '';
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            workspaceUri = this._panel.webview.asWebviewUri(
                vscode.workspace.workspaceFolders[0].uri
            ).toString();
        }

        this._panel.webview.postMessage({
            type: 'updateBoard',
            board: board,
            workspaceUri: workspaceUri
        });
    }


    private async saveToMarkdown() {
        if (!this._document || !this._board) return;

        // 获取配置设置
        const config = vscode.workspace.getConfiguration('markdown-kanban');
        const taskHeaderFormat = config.get<'title' | 'list'>('taskHeader', 'title');

        const markdown = MarkdownKanbanParser.generateMarkdown(this._board, taskHeaderFormat);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            this._document.uri,
            new vscode.Range(0, 0, this._document.lineCount, 0),
            markdown
        );
        await vscode.workspace.applyEdit(edit);
        await this._document.save();
    }

    private findColumn(columnId: string): KanbanColumn | undefined {
        return this._board?.columns.find(col => col.id === columnId);
    }

    private findTask(columnId: string, taskId: string): { column: KanbanColumn; task: KanbanTask; index: number } | undefined {
        const column = this.findColumn(columnId);
        if (!column) return undefined;

        const taskIndex = column.tasks.findIndex(task => task.id === taskId);
        if (taskIndex === -1) return undefined;

        return {
            column,
            task: column.tasks[taskIndex],
            index: taskIndex
        };
    }

    private async performAction(action: () => void) {
        if (!this._board) return;

        action();
        this._lastSelfSaveTime = Date.now();
        await this.saveToMarkdown();
        this._update();
    }

    private moveTask(taskId: string, fromColumnId: string, toColumnId: string, newIndex: number) {
        this.performAction(() => {
            const fromColumn = this.findColumn(fromColumnId);
            const toColumn = this.findColumn(toColumnId);

            if (!fromColumn || !toColumn) return;

            const taskIndex = fromColumn.tasks.findIndex(task => task.id === taskId);
            if (taskIndex === -1) return;

            const task = fromColumn.tasks.splice(taskIndex, 1)[0];
            toColumn.tasks.splice(newIndex, 0, task);
        });
    }

    private _getNextTaskId(): string {
        if (!this._board) return `TSK_1`;
        const id = `TSK_${this._board.nextId}`;
        this._board.nextId++;
        return id;
    }

    private addTask(columnId: string, taskData: any) {
        this.performAction(() => {
            const column = this.findColumn(columnId);
            if (!column) return;

            const newTask: KanbanTask = {
                id: this._getNextTaskId(),
                title: taskData.title,
                description: taskData.description,
                tags: taskData.tags || [],
                priority: taskData.priority,
                workload: taskData.workload,
                dueDate: taskData.dueDate,
                defaultExpanded: taskData.defaultExpanded,
                steps: taskData.steps || []
            };

            column.tasks.push(newTask);
        });
    }

    private deleteTask(taskId: string, columnId: string) {
        this.performAction(() => {
            const column = this.findColumn(columnId);
            if (!column) return;

            const taskIndex = column.tasks.findIndex(task => task.id === taskId);
            if (taskIndex === -1) return;

            column.tasks.splice(taskIndex, 1);
        });
    }

    private editTask(taskId: string, columnId: string, taskData: any) {
        this.performAction(() => {
            const result = this.findTask(columnId, taskId);
            if (!result) return;

            Object.assign(result.task, {
                title: taskData.title,
                description: taskData.description,
                tags: taskData.tags || [],
                priority: taskData.priority,
                workload: taskData.workload,
                dueDate: taskData.dueDate,
                defaultExpanded: taskData.defaultExpanded,
                steps: taskData.steps || []
            });
        });
    }

    private updateTaskStep(taskId: string, columnId: string, stepIndex: number, completed: boolean) {
        this.performAction(() => {
            const result = this.findTask(columnId, taskId);
            if (!result?.task.steps || stepIndex < 0 || stepIndex >= result.task.steps.length) {
                return;
            }

            result.task.steps[stepIndex].completed = completed;
        });
    }

    private updateChecklistItem(taskId: string, columnId: string, listKey: string, stepIndex: number, completed: boolean) {
        this.performAction(() => {
            const result = this.findTask(columnId, taskId);
            if (!result) return;

            const checklist = (result.task as any)[listKey];
            if (!checklist || stepIndex < 0 || stepIndex >= checklist.length) {
                return;
            }

            checklist[stepIndex].completed = completed;
        });
    }

    private reorderTaskSteps(taskId: string, columnId: string, newOrder: number[]) {
        this.performAction(() => {
            const result = this.findTask(columnId, taskId);
            if (!result?.task.steps) return;

            const originalSteps = [...result.task.steps];
            const reorderedSteps = newOrder
                .filter(index => index >= 0 && index < originalSteps.length)
                .map(index => originalSteps[index]);

            result.task.steps = reorderedSteps;
        });
    }

    private addColumn(title: string) {
        this.performAction(() => {
            if (!this._board) return;

            const newColumn: KanbanColumn = {
                id: Math.random().toString(36).substr(2, 9),
                title: title,
                tasks: []
            };

            this._board.columns.push(newColumn);
        });
    }

    private moveColumn(fromIndex: number, toIndex: number) {
        this.performAction(() => {
            if (!this._board || fromIndex === toIndex) return;

            const columns = this._board.columns;
            const column = columns.splice(fromIndex, 1)[0];
            columns.splice(toIndex, 0, column);
        });
    }

    private toggleTaskExpansion(taskId: string) {
        this._panel.webview.postMessage({
            type: 'toggleTaskExpansion',
            taskId: taskId
        });
    }

    private toggleColumnArchive(columnId: string, archived: boolean) {
        this.performAction(() => {
            const column = this.findColumn(columnId);
            if (!column) return;

            column.archived = archived;
        });
    }

    private _getHtmlForWebview() {
        const htmlDir = path.join(this._context.extensionPath, 'src', 'html');
        const filePath = vscode.Uri.file(path.join(htmlDir, 'webview.html'));
        let html = fs.readFileSync(filePath.fsPath, 'utf8');

        // Generate absolute webview URIs for CSS and JS (survives serialize/restore)
        const cssUri = this._panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(htmlDir, 'style.css'))
        );
        const scriptUri = this._panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(htmlDir, 'webviewScript.js'))
        );

        // CSP: allow images from webview resources, inline styles/scripts for existing handlers
        const cspSource = this._panel.webview.cspSource;
        const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'unsafe-inline'; font-src ${cspSource};">`;

        html = html.replace(/<head>/, `<head>${csp}`);

        // Replace relative paths with absolute webview URIs
        html = html.replace('./style.css', cssUri.toString());
        html = html.replace('./webviewScript.js', scriptUri.toString());

        return html;
    }

    private getNextImageFilename(dir: string, ext: string): string {
        if (!fs.existsSync(dir)) { return `image.${ext}`; }

        const files = fs.readdirSync(dir);
        const pattern = new RegExp(`^image(?:-(\\d+))?\\.${ext}$`);
        let maxN = -1;

        for (const file of files) {
            const match = file.match(pattern);
            if (match) {
                const n = match[1] ? parseInt(match[1]) : 0;
                if (n > maxN) { maxN = n; }
            }
        }

        if (maxN === -1) { return `image.${ext}`; }
        return `image-${maxN + 1}.${ext}`;
    }

    private async handlePasteImage(base64Data: string, ext: string) {
        if (!this._document) return;

        const docUri = this._document.uri;
        const docDir = path.dirname(docUri.fsPath);
        const docBasename = path.basename(docUri.fsPath);

        // Check markdown.copyFiles.destination setting
        const config = vscode.workspace.getConfiguration('markdown');
        const destinations = config.get<Record<string, string>>('copyFiles.destination');

        // Determine target directory from setting
        let targetDir = docDir;
        let relativeDir = '';

        if (destinations) {
            let destPattern: string | undefined;
            if (destinations[docBasename]) {
                destPattern = destinations[docBasename];
            } else if (destinations['**/*.md']) {
                destPattern = destinations['**/*.md'];
            }
            if (destPattern) {
                // Extract directory from pattern (e.g., "ss/tasks/${fileName}" -> "ss/tasks")
                const dirPart = destPattern.replace('${fileName}', '').replace(/\/$/, '');
                targetDir = path.resolve(docDir, dirPart);
                relativeDir = dirPart;
            }
        }

        // Ensure directory exists
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        // Generate filename matching VSCode's default: image.png, image-1.png, image-2.png, ...
        const fileName = this.getNextImageFilename(targetDir, ext);
        const savePath = path.join(targetDir, fileName);
        const relativeMdPath = relativeDir ? `${relativeDir}/${fileName}` : fileName;

        // Save the file
        const buffer = Buffer.from(base64Data, 'base64');
        fs.writeFileSync(savePath, buffer);

        // Send back the markdown image syntax
        this._panel.webview.postMessage({
            type: 'imageInserted',
            markdownText: `![alt text](${relativeMdPath.replace(/\\/g, '/')})`
        });
    }

    public dispose() {
        KanbanWebviewPanel.currentPanel = undefined;
        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            disposable?.dispose();
        }
    }
}