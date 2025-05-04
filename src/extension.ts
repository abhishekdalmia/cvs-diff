import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as readline from 'readline';

function sanitizePath(filePath: string): string {
    return path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
}

function generateTempFileName(originalName: string): string {
    const hash = crypto.createHash('sha256').update(originalName).digest('hex');
    return `temp_${hash}_${path.basename(originalName)}`;
}

function cleanupTempFiles(tempDir: string) {
    try {
        if (fs.existsSync(tempDir)) {
            const files = fs.readdirSync(tempDir);
            for (const file of files) {
                const filePath = path.join(tempDir, file);
                fs.unlinkSync(filePath);
            }
            fs.rmdirSync(tempDir);
        }
    } catch (error) {
        console.error('Error cleaning up temp files:', error);
    }
}

// CVS status codes and their meanings
const CVS_STATUS_MAP: Record<string, { label: string; icon: string; }> = {
    'M': { label: 'Modified', icon: '$(edit)' },
    'A': { label: 'Added', icon: '$(diff-added)' },
    'R': { label: 'Removed', icon: '$(diff-removed)' },
    'D': { label: 'Deleted', icon: '$(trash)' },
    'U': { label: 'Untracked', icon: '$(question)' },
    // Add more as needed
};

class CvsStatusGroup extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly icon: string
    ) {
        super(label, collapsibleState);
        this.iconPath = new vscode.ThemeIcon(icon.replace('$(', '').replace(')', ''));
    }
}

class CvsStatusItem extends vscode.TreeItem {
    constructor(
        public readonly filePath: string,
        public readonly status: string
    ) {
        super(path.basename(filePath), vscode.TreeItemCollapsibleState.None);
        this.tooltip = `${filePath} [${CVS_STATUS_MAP[status]?.label || status}]`;
        this.iconPath = new vscode.ThemeIcon(CVS_STATUS_MAP[status]?.icon.replace('$(', '').replace(')', '') || 'file');
        this.command = {
            command: 'cvs-diff-viewer.showLocalDiff',
            title: 'Show Local Changes',
            arguments: [vscode.Uri.file(path.join(this.workspaceRoot, filePath))]
        };
        this.contextValue = 'cvsStatusItem';
    }
    private get workspaceRoot(): string {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        return workspaceFolders ? workspaceFolders[0].uri.fsPath : '';
    }
}

class CvsGroupedTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
    private fileWatcher: vscode.FileSystemWatcher | undefined;

    constructor(private workspaceRoot: string) {
        this.setupFileWatcher();
    }

    public setupFileWatcher() {
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
        }
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.workspaceRoot, '**/*'),
            false, false, false
        );
        this.fileWatcher.onDidChange(() => this.refresh());
        this.fileWatcher.onDidCreate(() => this.refresh());
        this.fileWatcher.onDidDelete(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!this.workspaceRoot) return [];
        if (!element) {
            // Top-level: Local and Needs Update groups
            return [
                new vscode.TreeItem('Local Changes', vscode.TreeItemCollapsibleState.Expanded),
                new vscode.TreeItem('Needs Update', vscode.TreeItemCollapsibleState.Expanded)
            ];
        }
        if (element.label === 'Local Changes') {
            return await this.getLocalChangeItems();
        }
        if (element.label === 'Needs Update') {
            return await this.getNeedsUpdateItems();
        }
        return [];
    }

    private async getLocalChangeItems(): Promise<vscode.TreeItem[]> {
        // Use 'cvs diff -u' to find locally modified files
        const cvsDiff = child_process.spawnSync('cvs', ['diff', '-u'], {
            cwd: this.workspaceRoot,
            encoding: 'utf8'
        });
        if (cvsDiff.status !== 0 && cvsDiff.status !== 1) {
            return [];
        }
        const files = new Set<string>();
        for (const line of cvsDiff.stdout.split('\n')) {
            const match = line.match(/^Index: (.+)$/);
            if (match) {
                files.add(match[1].trim());
            }
        }
        // Also include locally added/removed files from 'cvs -n update'
        const cvsStatus = child_process.spawnSync('cvs', ['-n', 'update'], {
            cwd: this.workspaceRoot,
            encoding: 'utf8'
        });
        if (cvsStatus.status === 0 || cvsStatus.status === 1) {
            for (const line of cvsStatus.stdout.split('\n')) {
                const match = line.match(/^([A|R|M])\s+(.+)$/);
                if (match) {
                    files.add(match[2].trim());
                }
            }
        }
        return Array.from(files).map(filePath => {
            const item = new vscode.TreeItem(filePath, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('edit');
            item.command = {
                command: 'cvs-diff-viewer.showLocalDiff',
                title: 'Show Local Changes',
                arguments: [vscode.Uri.file(path.join(this.workspaceRoot, filePath))]
            };
            item.contextValue = 'cvsStatusItem';
            return item;
        });
    }

    private async getNeedsUpdateItems(): Promise<vscode.TreeItem[]> {
        // Use 'cvs -n update' to find files with U or P status
        const cvsStatus = child_process.spawnSync('cvs', ['-n', 'update'], {
            cwd: this.workspaceRoot,
            encoding: 'utf8'
        });
        if (cvsStatus.status !== 0 && cvsStatus.status !== 1) {
            return [];
        }
        const files = new Set<string>();
        for (const line of cvsStatus.stdout.split('\n')) {
            const match = line.match(/^([UP])\s+(.+)$/);
            if (match) {
                files.add(match[2].trim());
            }
        }
        return Array.from(files).map(filePath => {
            const item = new vscode.TreeItem(filePath, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('cloud-download');
            item.command = {
                command: 'cvs-diff-viewer.showNeedsUpdateDiff',
                title: 'Show Update Diff',
                arguments: [vscode.Uri.file(path.join(this.workspaceRoot, filePath))]
            };
            item.contextValue = 'cvsStatusItem';
            return item;
        });
    }
}

// Helper to get BASE revision from CVS/Entries
function getBaseRevision(filePath: string): string | null {
    const dir = path.dirname(filePath);
    const entriesPath = path.join(dir, 'CVS', 'Entries');
    if (!fs.existsSync(entriesPath)) return null;
    const fileName = path.basename(filePath);
    const lines = fs.readFileSync(entriesPath, 'utf8').split('\n');
    for (const line of lines) {
        // Format: /filename/revision/timestamp/flags/
        if (line.startsWith('/' + fileName + '/')) {
            const parts = line.split('/');
            if (parts.length > 2) {
                return parts[2]; // revision
            }
        }
    }
    return null;
}

export function activate(context: vscode.ExtensionContext) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
        const treeProvider = new CvsGroupedTreeProvider(workspaceRoot);
        vscode.window.registerTreeDataProvider('cvsDiffView', treeProvider);
        let disposable = vscode.commands.registerCommand('cvs-diff-viewer.refresh', () => {
            treeProvider.refresh();
        });
        context.subscriptions.push(disposable);
        context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                const newWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (newWorkspaceRoot) {
                    treeProvider.setupFileWatcher();
                }
            })
        );
        // Robust showLocalDiff: BASE from CVS/Entries
        context.subscriptions.push(vscode.commands.registerCommand('cvs-diff-viewer.showLocalDiff', async (uri: vscode.Uri) => {
            try {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    vscode.window.showErrorMessage('No workspace folder found');
                    return;
                }
                const relativePath = vscode.workspace.asRelativePath(uri);
                const filePath = sanitizePath(uri.fsPath);
                if (!fs.existsSync(filePath)) {
                    vscode.window.showErrorMessage(`File not found: ${filePath}`);
                    return;
                }
                const currentContent = fs.readFileSync(filePath, 'utf8');
                // Get BASE revision from CVS/Entries
                const baseRevision = getBaseRevision(filePath);
                if (!baseRevision) {
                    vscode.window.showErrorMessage('Could not determine BASE revision from CVS/Entries.');
                    return;
                }
                // Get BASE file content
                const cvsBase = child_process.spawnSync('cvs', ['update', '-p', '-r' + baseRevision, relativePath], {
                    cwd: workspaceFolder.uri.fsPath,
                    encoding: 'utf8'
                });
                if (cvsBase.status !== 0) {
                    vscode.window.showErrorMessage(`CVS update -p -r${baseRevision} failed: ${cvsBase.stderr}`);
                    return;
                }
                const baseContent = cvsBase.stdout;
                const tempDir = path.join(context.extensionPath, 'temp');
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }
                const baseFile = path.join(tempDir, generateTempFileName('base_' + filePath));
                const currentFile = path.join(tempDir, generateTempFileName('current_' + filePath));
                fs.writeFileSync(baseFile, baseContent);
                fs.writeFileSync(currentFile, currentContent);
                const baseUri = vscode.Uri.file(baseFile);
                const currentUri = vscode.Uri.file(currentFile);
                await vscode.commands.executeCommand('vscode.diff', baseUri, currentUri, `CVS Local Diff: ${path.basename(filePath)} (BASE vs Working Copy)`);
            } catch (error) {
                vscode.window.showErrorMessage(`Error showing local CVS diff: ${error}`);
            }
        }));

        // Needs Update diff command
        context.subscriptions.push(vscode.commands.registerCommand('cvs-diff-viewer.showNeedsUpdateDiff', async (uri: vscode.Uri) => {
            try {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    vscode.window.showErrorMessage('No workspace folder found');
                    return;
                }
                const relativePath = vscode.workspace.asRelativePath(uri);
                const filePath = sanitizePath(uri.fsPath);
                // Get BASE version using cvs diff -u (reconstruct base)
                const cvsDiff = child_process.spawnSync('cvs', ['diff', '-u', relativePath], {
                    cwd: workspaceFolder.uri.fsPath,
                    encoding: 'utf8'
                });
                const currentContent = fs.readFileSync(filePath, 'utf8');
                // Parse the diff output to reconstruct BASE
                const baseLines: string[] = [];
                let inHunk = false;
                for (const line of cvsDiff.stdout.split('\n')) {
                    if (line.startsWith('@@')) {
                        inHunk = true;
                        continue;
                    }
                    if (!inHunk) continue;
                    if (line.startsWith('-')) {
                        baseLines.push(line.substring(1));
                    } else if (line.startsWith(' ')) {
                        baseLines.push(line.substring(1));
                    }
                }
                const baseContent = baseLines.length > 0 ? baseLines.join('\n') : currentContent;
                // Get latest repo version
                const cvsOriginal = child_process.spawnSync('cvs', ['update', '-p', relativePath], {
                    cwd: workspaceFolder.uri.fsPath,
                    encoding: 'utf8'
                });
                if (cvsOriginal.status !== 0) {
                    vscode.window.showErrorMessage(`CVS update -p failed: ${cvsOriginal.stderr}`);
                    return;
                }
                const originalContent = cvsOriginal.stdout;
                const tempDir = path.join(context.extensionPath, 'temp');
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }
                const baseFile = path.join(tempDir, generateTempFileName('base_' + filePath));
                const originalFile = path.join(tempDir, generateTempFileName('original_' + filePath));
                fs.writeFileSync(baseFile, baseContent);
                fs.writeFileSync(originalFile, originalContent);
                const baseUri = vscode.Uri.file(baseFile);
                const originalUri = vscode.Uri.file(originalFile);
                await vscode.commands.executeCommand('vscode.diff', baseUri, originalUri, `CVS Update Diff: ${path.basename(filePath)} (BASE vs Repository)`);
            } catch (error) {
                vscode.window.showErrorMessage(`Error showing CVS update diff: ${error}`);
            }
        }));
    }

    // Register cleanup on deactivation
    context.subscriptions.push({
        dispose: () => {
            const tempDir = path.join(context.extensionPath, 'temp');
            cleanupTempFiles(tempDir);
        }
    });
}

export function deactivate() {
    // Cleanup is handled by the subscription
} 