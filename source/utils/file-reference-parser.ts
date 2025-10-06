import {readFileSync, existsSync, statSync, readdirSync} from 'node:fs';
import {join, resolve, isAbsolute, relative} from 'node:path';

export interface FileReference {
	originalPattern: string;
	filePath: string;
	startLine?: number;
	endLine?: number;
	exists: boolean;
	content?: string;
	error?: string;
}

export interface ParsedMessage {
	processedMessage: string;
	fileReferences: FileReference[];
	includedContent: string[];
}

/**
 * Parse @filename patterns from a message and extract file references
 * Supports:
 * - @filename.ts - entire file
 * - @filename.ts:10-20 - specific line range
 * - @src/components/Button.tsx - relative paths
 * - Multiple @ references in one message
 */
export function parseFileReferences(
	message: string,
	workingDirectory: string = process.cwd(),
): ParsedMessage {
	// Regex to match @filename patterns with optional line ranges
	const fileReferenceRegex = /@([^\s@:]+(?:\.[^\s@:]*)*(?::\d+(?:-\d+)?)?)/g;
	const matches = [...message.matchAll(fileReferenceRegex)];

	const fileReferences: FileReference[] = [];
	const includedContent: string[] = [];
	let processedMessage = message;

	for (const match of matches) {
		const fullMatch = match[0];
		const pattern = match[1];

		// Check if it's a glob pattern
		if (pattern.includes('*')) {
			const globRefs = expandGlobPattern(pattern, workingDirectory);
			fileReferences.push(...globRefs);

			for (const fileRef of globRefs) {
				if (fileRef.exists && fileRef.content) {
					includedContent.push(fileRef.content);
				}
			}

			// Replace with a summary of matched files
			const validCount = globRefs.filter(ref => ref.exists).length;
			const summary = validCount > 0 ? `${validCount} files` : 'no files';
			processedMessage = processedMessage.replace(
				fullMatch,
				`[${summary} from ${pattern}]`,
			);
		} else {
			const fileRef = parseFileReference(pattern, workingDirectory);
			fileReferences.push(fileRef);

			if (fileRef.exists && fileRef.content) {
				includedContent.push(fileRef.content);
			}

			// Replace the @reference with just the filename for cleaner display
			const fileName = fileRef.filePath.split('/').pop() || pattern;
			processedMessage = processedMessage.replace(fullMatch, fileName);
		}
	}

	return {
		processedMessage,
		fileReferences,
		includedContent,
	};
}

/**
 * Expand glob patterns to multiple file references
 * Supports basic patterns like @src/*.ts
 */
function expandGlobPattern(
	pattern: string,
	workingDirectory: string,
): FileReference[] {
	// Simple glob expansion for common patterns
	if (!pattern.includes('*')) {
		return [parseFileReference(pattern, workingDirectory)];
	}

	const fileReferences: FileReference[] = [];

	try {
		// For now, implement a simple glob expansion for common cases
		const parts = pattern.split('/');
		const lastPart = parts[parts.length - 1];

		if (parts.length === 1 && lastPart.includes('*')) {
			// Simple pattern like *.ts in current directory
			const prefix = lastPart.replace(/\*.*$/, '');
			const extension = lastPart.includes('.') ? lastPart.split('.').pop() : '';

			const items = readdirSync(workingDirectory, {withFileTypes: true});
			for (const item of items) {
				if (item.isFile() && item.name.startsWith(prefix)) {
					if (!extension || item.name.endsWith(`.${extension}`)) {
						const fileRef = parseFileReference(item.name, workingDirectory);
						if (fileRef.exists) {
							fileRef.originalPattern = pattern;
							fileReferences.push(fileRef);
						}
					}
				}
			}
		} else if (parts.length === 2 && lastPart.includes('*')) {
			// Pattern like src/*.ts
			const dirPath = resolve(workingDirectory, parts[0]);
			if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
				const prefix = lastPart.replace(/\*.*$/, '');
				const extension = lastPart.includes('.')
					? lastPart.split('.').pop()
					: '';

				const items = readdirSync(dirPath, {withFileTypes: true});
				for (const item of items) {
					if (item.isFile() && item.name.startsWith(prefix)) {
						if (!extension || item.name.endsWith(`.${extension}`)) {
							const relativePath = join(parts[0], item.name);
							const fileRef = parseFileReference(
								relativePath,
								workingDirectory,
							);
							if (fileRef.exists) {
								fileRef.originalPattern = pattern;
								fileReferences.push(fileRef);
							}
						}
					}
				}
			}
		} else {
			// For complex patterns, return an error
			return [
				{
					originalPattern: pattern,
					filePath: pattern,
					exists: false,
					error:
						'Complex glob patterns not yet supported. Use simple patterns like *.ts or src/*.tsx',
				},
			];
		}

		return fileReferences;
	} catch (error) {
		return [
			{
				originalPattern: pattern,
				filePath: pattern,
				exists: false,
				error: `Failed to expand glob pattern: ${
					error instanceof Error ? error.message : String(error)
				}`,
			},
		];
	}
}

/**
 * Parse a single file reference pattern
 */
function parseFileReference(
	pattern: string,
	workingDirectory: string,
): FileReference {
	// Extract line range if present
	const lineRangeMatch = pattern.match(/^(.+?)(?::(\d+)(?:-(\d+))?)?$/);
	if (!lineRangeMatch) {
		return {
			originalPattern: pattern,
			filePath: pattern,
			exists: false,
			error: 'Invalid file reference format',
		};
	}

	const [, filePath, startLineStr, endLineStr] = lineRangeMatch;
	const startLine = startLineStr ? parseInt(startLineStr, 10) : undefined;
	const endLine = endLineStr ? parseInt(endLineStr, 10) : undefined;

	// Resolve the file path
	let resolvedPath: string;
	if (isAbsolute(filePath)) {
		resolvedPath = filePath;
	} else {
		resolvedPath = resolve(workingDirectory, filePath);
	}

	// Security check: ensure the resolved path is within the working directory or its subdirectories
	const relativePath = relative(workingDirectory, resolvedPath);
	if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
		return {
			originalPattern: pattern,
			filePath,
			startLine,
			endLine,
			exists: false,
			error: 'File path outside of working directory (security restriction)',
		};
	}

	// Check if file exists
	if (!existsSync(resolvedPath)) {
		return {
			originalPattern: pattern,
			filePath,
			startLine,
			endLine,
			exists: false,
			error: 'File not found',
		};
	}

	// Check if it's a file (not a directory)
	const stats = statSync(resolvedPath);
	if (!stats.isFile()) {
		return {
			originalPattern: pattern,
			filePath,
			startLine,
			endLine,
			exists: false,
			error: 'Path is not a file',
		};
	}

	// Read file content
	try {
		const content = readFileSync(resolvedPath, 'utf-8');
		const lines = content.split('\n');

		// Apply line range if specified
		let finalContent = content;
		if (startLine !== undefined || endLine !== undefined) {
			const actualStartLine = startLine || 1;
			const actualEndLine = endLine || lines.length;

			// Validate line range
			if (
				actualStartLine < 1 ||
				actualEndLine > lines.length ||
				actualStartLine > actualEndLine
			) {
				return {
					originalPattern: pattern,
					filePath,
					startLine,
					endLine,
					exists: false,
					error: `Invalid line range: ${actualStartLine}-${actualEndLine} (file has ${lines.length} lines)`,
				};
			}

			const selectedLines = lines.slice(actualStartLine - 1, actualEndLine);
			finalContent = selectedLines.join('\n');
		}

		return {
			originalPattern: pattern,
			filePath: relativePath,
			startLine,
			endLine,
			exists: true,
			content: finalContent,
		};
	} catch (error) {
		return {
			originalPattern: pattern,
			filePath,
			startLine,
			endLine,
			exists: false,
			error: `Failed to read file: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}

/**
 * Get file path suggestions for tab completion
 */
export function getFileSuggestions(
	partialPath: string,
	workingDirectory: string = process.cwd(),
): string[] {
	try {
		const dirPath = partialPath.includes('/')
			? resolve(workingDirectory, partialPath.split('/').slice(0, -1).join('/'))
			: workingDirectory;

		const prefix = partialPath.includes('/')
			? partialPath.split('/').pop() || ''
			: partialPath;

		if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
			return [];
		}

		const items = readdirSync(dirPath, {withFileTypes: true});

		return items
			.filter((item: any) => item.name.startsWith(prefix))
			.map((item: any) => {
				const fullPath = join(dirPath, item.name);
				const relativePath = relative(workingDirectory, fullPath);
				return item.isDirectory() ? `${relativePath}/` : relativePath;
			})
			.sort();
	} catch (error) {
		return [];
	}
}
