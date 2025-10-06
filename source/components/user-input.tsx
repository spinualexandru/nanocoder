import {Box, Text, useFocus, useInput} from 'ink';
import TextInput from 'ink-text-input';
import {useCallback, useEffect, useState} from 'react';
import {useTheme} from '../hooks/useTheme.js';
import {promptHistory} from '../prompt-history.js';
import {commandRegistry} from '../commands.js';
import {useTerminalWidth} from '../hooks/useTerminalWidth.js';
import {useUIStateContext} from '../hooks/useUIState.js';
import {useInputState} from '../hooks/useInputState.js';
import {Completion, CompletionTypes} from '../types/index.js';
import {getFileSuggestions} from '../utils/file-reference-parser.js';

interface ChatProps {
	onSubmit?: (message: string) => void;
	placeholder?: string;
	customCommands?: string[]; // List of custom command names and aliases
	disabled?: boolean; // Disable input when AI is processing
	onCancel?: () => void; // Callback when user presses escape while thinking
}

export default function UserInput({
	onSubmit,
	placeholder = 'Type `/` for commands, @filename.ts to include files, or `!` for bash. Use Tab for completion.',
	customCommands = [],
	disabled = false,
	onCancel,
}: ChatProps) {
	const {isFocused, focus} = useFocus({autoFocus: !disabled, id: 'user-input'});
	const {colors} = useTheme();
	const inputState = useInputState();
	const uiState = useUIStateContext();
	const boxWidth = useTerminalWidth();
	const [textInputKey, setTextInputKey] = useState(0);

	const {
		input,
		hasLargeContent,
		originalInput,
		historyIndex,
		setOriginalInput,
		setHistoryIndex,
		updateInput,
		resetInput,
		cachedLineCount,
	} = inputState;

	const {
		showClearMessage,
		showFullContent,
		showCompletions,
		completions,
		setShowClearMessage,
		setShowFullContent,
		setShowCompletions,
		setCompletions,
		resetUIState,
	} = uiState;

	// State for completion navigation
	const [selectedCompletionIndex, setSelectedCompletionIndex] = useState(0);
	const [completionType, setCompletionType] = useState<
		'command' | 'file' | null
	>(null);
	const [justCompleted, setJustCompleted] = useState(false);

	// Check if we're in bash mode (input starts with !)
	const isBashMode = input.trim().startsWith('!');

	// Load history on mount
	useEffect(() => {
		promptHistory.loadHistory();
	}, []);

	// Helper functions

	const getExpandKey = () => 'Ctrl+B';

	// Command completion logic
	const handleCommandCompletion = useCallback(
		(commandPrefix: string) => {
			const builtInCompletions = commandRegistry.getCompletions(commandPrefix);
			const customCompletions = customCommands.filter(cmd =>
				cmd.startsWith(commandPrefix),
			);

			const allCompletions: Completion[] = [
				...builtInCompletions.map(cmd => ({name: cmd, isCustom: false})),
				...customCompletions.map(cmd => ({name: cmd, isCustom: true})),
			];

			if (allCompletions.length === 1) {
				// Auto-complete when there's exactly one match
				const completion = allCompletions[0];
				const completedText = `/${completion.name}`;

				// Force TextInput to remount by changing its key, which resets cursor position
				updateInput(completedText);
				setTextInputKey(prev => prev + 1);
				setShowCompletions(false);
				setCompletions([]);
				setCompletionType(null);
			} else if (allCompletions.length > 1) {
				// Show completions when there are multiple matches
				setCompletions(allCompletions);
				setShowCompletions(true);
				setSelectedCompletionIndex(0);
				setCompletionType('command');
			}
		},
		[customCommands, setCompletions, setShowCompletions, updateInput],
	);

	// File completion logic for @ syntax
	const handleFileCompletion = useCallback(
		(partialPath: string) => {
			const suggestions = getFileSuggestions(partialPath);

			if (suggestions.length === 1) {
				// Auto-complete when there's exactly one match
				const completedText = `@${suggestions[0]}`;
				updateInput(completedText);
				setTextInputKey(prev => prev + 1);
				setShowCompletions(false);
				setCompletions([]);
				setCompletionType(null);
			} else if (suggestions.length > 1) {
				// Show file suggestions when there are multiple matches
				const fileCompletions: Completion[] = suggestions.map(suggestion => ({
					name: suggestion,
					isCustom: false,
				}));
				setCompletions(fileCompletions);
				setShowCompletions(true);
				setSelectedCompletionIndex(0);
				setCompletionType('file');
			}
		},
		[setCompletions, setShowCompletions, updateInput],
	);

	// Apply selected completion
	const applySelectedCompletion = useCallback(() => {
		if (
			completions.length === 0 ||
			selectedCompletionIndex >= completions.length
		)
			return;

		const selectedCompletion = completions[selectedCompletionIndex];
		let completedText: string;

		if (completionType === 'command') {
			completedText = `/${selectedCompletion.name}`;
		} else if (completionType === 'file') {
			// For file completion, we need to replace the part after @
			const atIndex = input.lastIndexOf('@');
			const beforeAt = input.slice(0, atIndex);
			completedText = `${beforeAt}@${selectedCompletion.name}`;
		} else {
			return;
		}

		updateInput(completedText);
		setTextInputKey(prev => prev + 1);
		setShowCompletions(false);
		setCompletions([]);
		setSelectedCompletionIndex(0);
		setCompletionType(null);
		setJustCompleted(true);

		// Clear the justCompleted flag after a short delay
		setTimeout(() => setJustCompleted(false), 200);
	}, [
		completions,
		selectedCompletionIndex,
		completionType,
		input,
		updateInput,
		setShowCompletions,
		setCompletions,
	]);

	// Navigate completion options
	const navigateCompletions = useCallback(
		(direction: 'up' | 'down') => {
			if (!showCompletions || completions.length === 0) return;

			if (direction === 'up') {
				setSelectedCompletionIndex(prev =>
					prev === 0 ? completions.length - 1 : prev - 1,
				);
			} else {
				setSelectedCompletionIndex(prev =>
					prev === completions.length - 1 ? 0 : prev + 1,
				);
			}
		},
		[showCompletions, completions.length],
	);

	// Handle form submission
	const handleSubmit = useCallback(() => {
		if (input.trim() && onSubmit) {
			const message = input.trim();
			promptHistory.addPrompt(message);
			onSubmit(message);
			resetInput();
			resetUIState();
			promptHistory.resetIndex();
			// Reset completion state
			setShowCompletions(false);
			setCompletions([]);
			setSelectedCompletionIndex(0);
			setCompletionType(null);
		}
	}, [
		input,
		onSubmit,
		resetInput,
		resetUIState,
		setShowCompletions,
		setCompletions,
	]);

	// Handle escape key logic
	const handleEscape = useCallback(() => {
		if (showClearMessage) {
			resetInput();
			resetUIState();
			focus('user-input');
		} else {
			setShowClearMessage(true);
		}
	}, [showClearMessage, resetInput, resetUIState, setShowClearMessage, focus]);

	// History navigation
	const handleHistoryNavigation = useCallback(
		(direction: 'up' | 'down') => {
			const history = promptHistory.getHistory();
			if (history.length === 0) return;

			if (direction === 'up') {
				if (historyIndex === -1) {
					setOriginalInput(input);
					setHistoryIndex(history.length - 1);
					updateInput(history[history.length - 1]);
					setTextInputKey(prev => prev + 1);
				} else if (historyIndex > 0) {
					const newIndex = historyIndex - 1;
					setHistoryIndex(newIndex);
					updateInput(history[newIndex]);
					setTextInputKey(prev => prev + 1);
				} else {
					setHistoryIndex(-2);
					updateInput('');
					setTextInputKey(prev => prev + 1);
				}
			} else {
				if (historyIndex >= 0 && historyIndex < history.length - 1) {
					const newIndex = historyIndex + 1;
					setHistoryIndex(newIndex);
					updateInput(history[newIndex]);
					setTextInputKey(prev => prev + 1);
				} else if (historyIndex === history.length - 1) {
					setHistoryIndex(-1);
					updateInput(originalInput);
					setOriginalInput('');
					setTextInputKey(prev => prev + 1);
				} else if (historyIndex === -2) {
					setHistoryIndex(0);
					updateInput(history[0]);
					setTextInputKey(prev => prev + 1);
				}
			}
		},
		[
			historyIndex,
			input,
			originalInput,
			setHistoryIndex,
			setOriginalInput,
			updateInput,
		],
	);

	useInput((inputChar, key) => {
		// Handle escape for cancellation even when disabled
		if (key.escape && disabled && onCancel) {
			onCancel();
			return;
		}

		// Block all other input when disabled
		if (disabled) {
			return;
		}

		// Handle special keys
		if (key.escape) {
			if (showCompletions) {
				// Cancel completions first
				setShowCompletions(false);
				setCompletions([]);
				setSelectedCompletionIndex(0);
				setCompletionType(null);
				return;
			} else {
				handleEscape();
				return;
			}
		}

		if (key.ctrl && inputChar === 'b') {
			if (hasLargeContent && input.length > 150) {
				setShowFullContent(prev => !prev);
			}
			return;
		}

		if (key.tab) {
			if (showCompletions) {
				// If completions are shown, apply the selected one
				applySelectedCompletion();
				return;
			} else if (input.startsWith('/')) {
				const commandPrefix = input.slice(1).split(' ')[0];
				handleCommandCompletion(commandPrefix);
				return;
			} else if (input.includes('@')) {
				// Find the last @ and complete file path
				const atIndex = input.lastIndexOf('@');
				const partialPath = input.slice(atIndex + 1);
				handleFileCompletion(partialPath);
				return;
			}
		}

		// Clear justCompleted flag when user starts typing
		if (
			justCompleted &&
			inputChar &&
			!key.tab &&
			!key.upArrow &&
			!key.downArrow &&
			!key.escape
		) {
			setJustCompleted(false);
		}

		// Only clear completions on specific keys that would cancel them
		if (showCompletions && (key.return || key.ctrl || key.meta)) {
			setShowCompletions(false);
			setCompletions([]);
			setSelectedCompletionIndex(0);
			setCompletionType(null);
		}
		if (showClearMessage) {
			setShowClearMessage(false);
			focus('user-input');
		}

		// Handle return keys
		if (key.return && key.shift) {
			updateInput(input + '\n');
			return;
		}

		// Handle navigation
		if (key.upArrow) {
			if (showCompletions) {
				navigateCompletions('up');
				return;
			} else {
				handleHistoryNavigation('up');
				return;
			}
		}

		if (key.downArrow) {
			if (showCompletions) {
				navigateCompletions('down');
				return;
			} else {
				handleHistoryNavigation('down');
				return;
			}
		}
	});

	// Helper function to highlight @ file references in input
	const highlightFileReferences = (text: string) => {
		if (!text) return text;

		const parts = text.split(/(@[^\s@:]+(?:\.[^\s@:]*)*(?::\d+(?:-\d+)?)?)/g);

		return parts.map((part, index) => {
			if (part.startsWith('@')) {
				return (
					<Text key={index} color={colors.info} bold underline>
						{part}
					</Text>
				);
			}
			return part;
		});
	};

	// Helper function to highlight placeholder text
	const highlightPlaceholder = (text: string) => {
		const parts = text.split(/(@[^\s@]+)/g);

		return parts.map((part, index) => {
			if (part.startsWith('@')) {
				return (
					<Text key={index} color={colors.info} bold>
						{part}
					</Text>
				);
			}
			return part;
		});
	};

	// Render function - NEVER modifies state, only for display
	const renderDisplayContent = () => {
		if (!input) return placeholder;

		if (hasLargeContent && input.length > 150 && !showFullContent) {
			// Use cached line count from the hook (debounced)
			return (
				<>
					{`[${input.length} characters, ${cachedLineCount} lines] `}
					<Text color={colors.secondary}>({getExpandKey()} to expand)</Text>
				</>
			);
		}

		return highlightFileReferences(input);
	};

	const textColor = disabled || !input ? colors.secondary : colors.primary;

	return (
		<Box flexDirection="column" paddingY={1} width="100%" marginTop={1}>
			<Box
				flexDirection="column"
				borderStyle={isBashMode ? 'round' : undefined}
				borderColor={isBashMode ? colors.tool : undefined}
				paddingX={isBashMode ? 1 : 0}
				width={isBashMode ? boxWidth : undefined}
			>
				{!isBashMode && (
					<>
						<Text color={disabled ? colors.secondary : colors.primary} bold>
							{disabled
								? 'Please wait, AI is thinking...'
								: 'What would you like me to help with?'}
						</Text>
					</>
				)}

				{/* Input row */}
				{hasLargeContent && input.length > 150 && !showFullContent ? (
					<Text color={textColor}>
						{'>'} {renderDisplayContent()}
					</Text>
				) : (
					<Box>
						<Text color={textColor}>{'>'} </Text>
						{disabled ? (
							<Text color={colors.secondary}>...</Text>
						) : showCompletions || !isFocused || justCompleted ? (
							// Show highlighted input when:
							// - Completions are active, OR
							// - Input is not focused, OR
							// - Just completed a selection (briefly show highlighting)
							<Text color={textColor}>
								{input
									? highlightFileReferences(input)
									: highlightPlaceholder(placeholder)}
							</Text>
						) : (
							// Normal TextInput when focused and no special conditions
							<TextInput
								key={textInputKey}
								value={input}
								onChange={updateInput}
								onSubmit={handleSubmit}
								placeholder={placeholder}
								focus={isFocused}
							/>
						)}
					</Box>
				)}

				{isBashMode && (
					<Text color={colors.tool} dimColor>
						Bash Mode
					</Text>
				)}
				{showCompletions && (
					<Text color={colors.info} dimColor>
						Tab Completion Mode - Use ↑/↓ to navigate, Tab to select
					</Text>
				)}
				{showClearMessage && (
					<Text color={colors.secondary} dimColor>
						Press escape again to clear
					</Text>
				)}
				{showCompletions && completions.length > 0 && (
					<Box flexDirection="column" marginTop={1}>
						<Text color={colors.secondary}>
							{completionType === CompletionTypes.File
								? 'Available files:'
								: 'Available commands:'}
						</Text>
						{completions.map((completion, index) => {
							const isSelected = index === selectedCompletionIndex;
							const prefix =
								completionType === CompletionTypes.File ? '@' : '/';
							const isDirectory =
								completionType === CompletionTypes.File &&
								completion.name.endsWith('/');
							const icon = isDirectory ? '📁' : '📄';
							return (
								<Text
									key={index}
									color={completion.isCustom ? colors.info : colors.primary}
									backgroundColor={isSelected ? colors.secondary : undefined}
									bold={isSelected}
								>
									{icon} {prefix}
									{completion.name}
								</Text>
							);
						})}
						<Text color={colors.secondary} dimColor>
							Use ↑/↓ to navigate, Tab to select, Esc to cancel
						</Text>
					</Box>
				)}
			</Box>
		</Box>
	);
}
