# CVS Diff Viewer

A VSCode extension that displays CVS diff output in a side-by-side view similar to Git diff.

## Features

- Shows CVS diff output in a side-by-side comparison view
- Color-coded changes (red for deletions, green for additions)
- Accessible from the file explorer context menu
- Uses VSCode's built-in diff viewer for a familiar experience

## Usage

1. Right-click on a file in the VSCode explorer
2. Select "Show CVS Diff" from the context menu
3. The diff will be displayed in a side-by-side view showing:
   - Left side: Repository version
   - Right side: Your working copy
   - Changes are highlighted in red (deletions) and green (additions)

## Requirements

- CVS must be installed and available in your system PATH
- The workspace must be a CVS repository

## Installation

1. Clone this repository
2. Run `npm install`
3. Run `npm run compile`
4. Press F5 to start debugging the extension

## Extension Settings

This extension contributes the following settings:

* `cvs-diff-viewer.enable`: Enable/disable the extension

## Known Issues

- The extension assumes CVS is properly configured in your environment
- Only works with single file diffs at the moment
- Temporary files are created in the extension's directory for diff viewing

## Release Notes

### 0.0.1

Initial release of CVS Diff Viewer with side-by-side comparison 