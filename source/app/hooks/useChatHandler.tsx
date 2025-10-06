import {LLMClient, Message, ToolCall, ToolResult} from '../../types/core.js';
import {ToolManager} from '../../tools/tool-manager.js';
import {toolDefinitions} from '../../tools/index.js';
import {processPromptTemplate} from '../../utils/prompt-processor.js';
import {
	parseToolCallsFromContent,
	cleanContentFromToolCalls,
} from '../../tool-calling/index.js';
import {ConversationStateManager} from '../utils/conversationState.js';
import {parseFileReferences} from '../../utils/file-reference-parser.js';
import UserMessage from '../../components/user-message.js';
import AssistantMessage from '../../components/assistant-message.js';
import ErrorMessage from '../../components/error-message.js';
import ToolMessage from '../../components/tool-message.js';
import {ThinkingStats} from './useAppState.js';
import React from 'react';

// Helper function to filter out invalid tool calls and deduplicate by ID and function
const filterValidToolCalls = (toolCalls: any[]): any[] => {
	const seenIds = new Set<string>();
	const seenFunctionCalls = new Set<string>();

	return toolCalls.filter(toolCall => {
		// Filter out completely empty tool calls
		if (!toolCall.id || !toolCall.function?.name) {
			return false;
		}

		// Filter out tool calls with empty names
		if (toolCall.function.name.trim() === '') {
			return false;
		}

		// Filter out tool calls for tools that don't exist

		// Filter out duplicate tool call IDs (GPT-5 issue)
		if (seenIds.has(toolCall.id)) {
			return false;
		}

		// Filter out functionally identical tool calls (same tool + args)
		const functionSignature = `${toolCall.function.name}:${JSON.stringify(
			toolCall.function.arguments,
		)}`;
		if (seenFunctionCalls.has(functionSignature)) {
			return false;
		}

		seenIds.add(toolCall.id);
		seenFunctionCalls.add(functionSignature);
		return true;
	});
};

interface UseChatHandlerProps {
	client: LLMClient | null;
	toolManager: ToolManager | null;
	messages: Message[];
	setMessages: (messages: Message[]) => void;
	getMessageTokens?: (message: Message) => number;
	currentModel: string;
	setIsThinking: (thinking: boolean) => void;
	setIsCancelling: (cancelling: boolean) => void;
	setThinkingStats: (
		stats: ThinkingStats | ((prev: ThinkingStats) => ThinkingStats),
	) => void;
	addToChatQueue: (component: React.ReactNode) => void;
	componentKeyCounter: number;
	abortController: AbortController | null;
	setAbortController: (controller: AbortController | null) => void;
	onStartToolConfirmationFlow: (
		toolCalls: any[],
		updatedMessages: Message[],
		assistantMsg: Message,
		systemMessage: Message,
	) => void;
}

export function useChatHandler({
	client,
	toolManager,
	messages,
	setMessages,
	getMessageTokens,
	currentModel,
	setIsThinking,
	setIsCancelling,
	setThinkingStats,
	addToChatQueue,
	componentKeyCounter,
	abortController,
	setAbortController,
	onStartToolConfirmationFlow,
}: UseChatHandlerProps) {
	// Conversation state manager for enhanced context
	const conversationStateManager = React.useRef(new ConversationStateManager());

	// Reset conversation state when messages are cleared
	React.useEffect(() => {
		if (messages.length === 0) {
			conversationStateManager.current.reset();
		}
	}, [messages.length]);
	// Display tool result with proper formatting (similar to useToolHandler)
	const displayToolResult = async (toolCall: any, result: any) => {
		if (toolManager) {
			const formatter = toolManager.getToolFormatter(result.name);
			if (formatter) {
				try {
					// Parse arguments if they're a JSON string
					let parsedArgs = toolCall.function.arguments;
					if (typeof parsedArgs === 'string') {
						try {
							parsedArgs = JSON.parse(parsedArgs);
						} catch (e) {
							// If parsing fails, use as-is
						}
					}
					const formattedResult = await formatter(parsedArgs, result.content);

					if (React.isValidElement(formattedResult)) {
						addToChatQueue(
							React.cloneElement(formattedResult, {
								key: `tool-result-${
									result.tool_call_id
								}-${componentKeyCounter}-${Date.now()}`,
							}),
						);
					} else {
						addToChatQueue(
							<ToolMessage
								key={`tool-result-${
									result.tool_call_id
								}-${componentKeyCounter}-${Date.now()}`}
								title={`⚒ ${result.name}`}
								message={String(formattedResult)}
								hideBox={true}
							/>,
						);
					}
				} catch (formatterError) {
					// If formatter fails, show raw result
					addToChatQueue(
						<ToolMessage
							key={`tool-result-${result.tool_call_id}-${componentKeyCounter}`}
							title={`⚒ ${result.name}`}
							message={result.content}
							hideBox={true}
						/>,
					);
				}
			} else {
				// No formatter, show raw result
				addToChatQueue(
					<ToolMessage
						key={`tool-result-${result.tool_call_id}-${componentKeyCounter}`}
						title={`⚒ ${result.name}`}
						message={result.content}
						hideBox={true}
					/>,
				);
			}
		}
	};
	// Throttle thinking stats updates to reduce re-renders
	const throttledSetThinkingStats = React.useCallback(
		(() => {
			let lastUpdate = 0;
			const throttleMs = 250; // Update at most 4 times per second

			return (
				stats: ThinkingStats | ((prev: ThinkingStats) => ThinkingStats),
			) => {
				const now = Date.now();
				if (now - lastUpdate >= throttleMs) {
					lastUpdate = now;
					setThinkingStats(stats);
				}
			};
		})(),
		[setThinkingStats],
	);

	// Helper to make async iterator cancellable with frequent abort checking
	const makeCancellableStream = async function* (
		stream: AsyncIterable<any>,
		abortSignal?: AbortSignal,
	): AsyncIterable<any> {
		const iterator = stream[Symbol.asyncIterator]();
		try {
			while (true) {
				if (abortSignal?.aborted) {
					throw new Error('Operation was cancelled');
				}

				// Use Promise.race to make iterator.next() cancellable with frequent checking
				const nextPromise = iterator.next();
				const timeoutPromise = new Promise(resolve => {
					const checkInterval = setInterval(() => {
						if (abortSignal?.aborted) {
							clearInterval(checkInterval);
							resolve({done: false, cancelled: true});
						}
					}, 100); // Check every 100ms

					// Clear interval when next() completes
					nextPromise.finally(() => clearInterval(checkInterval));
				});

				const result = (await Promise.race([
					nextPromise,
					timeoutPromise,
				])) as any;

				if (result.cancelled || abortSignal?.aborted) {
					throw new Error('Operation was cancelled');
				}

				if (result.done) break;

				yield result.value;
			}
		} finally {
			if (iterator.return) {
				await iterator.return();
			}
		}
	};

	// Process assistant response with token tracking (for initial user messages)
	const processAssistantResponseWithTokenTracking = async (
		systemMessage: Message,
		messages: Message[],
		controller: AbortController,
	) => {
		if (!client) return;

		const stream = client.chatStream(
			[systemMessage, ...messages],
			toolManager?.getAllTools() || [],
		);

		let toolCalls: any = null;
		let fullContent = '';
		let tokenCount = 0;
		let hasContent = false;

		// Process streaming response with cancellation support
		const cancellableStream = makeCancellableStream(stream, controller.signal);
		for await (const chunk of cancellableStream) {
			hasContent = true;

			if (chunk.message?.content) {
				fullContent += chunk.message.content;
				tokenCount = Math.ceil(fullContent.length / 4);
			}

			// If server provides eval_count, use it as it's more accurate
			// But ensure we don't reset to a lower count if content tokens are higher
			if (chunk.eval_count) {
				tokenCount = Math.max(tokenCount, chunk.eval_count);
			}

			if (chunk.message?.tool_calls) {
				toolCalls = chunk.message.tool_calls;
			}

			// Update thinking stats in real-time
			if (!chunk.done) {
				const systemTokens = Math.ceil(systemMessage.content.length / 4); // Use actual system prompt length
				const conversationTokens = getMessageTokens
					? messages.reduce((total, msg) => total + getMessageTokens(msg), 0)
					: messages.reduce(
							(total, msg) => total + Math.ceil((msg.content?.length || 0) / 4),
							0,
					  );
				const totalTokensUsed = systemTokens + conversationTokens + tokenCount;

				throttledSetThinkingStats({
					tokenCount,
					contextSize: client.getContextSize(),
					totalTokensUsed,
					tokensPerSecond: chunk.tokens_per_second,
				});
			}
		}

		if (!hasContent) {
			throw new Error('No response received from model');
		}

		// Parse any tool calls from content for non-tool-calling models
		const parsedToolCalls = parseToolCallsFromContent(fullContent);
		const cleanedContent = cleanContentFromToolCalls(
			fullContent,
			parsedToolCalls,
		);

		// Display the assistant response (cleaned of any tool calls)
		if (cleanedContent.trim()) {
			addToChatQueue(
				<AssistantMessage
					key={`assistant-${componentKeyCounter}`}
					message={cleanedContent}
					model={currentModel}
				/>,
			);
		}

		// Merge structured tool calls from LangGraph with content-parsed tool calls
		const allToolCalls = [...(toolCalls || []), ...parsedToolCalls];
		const validToolCalls = filterValidToolCalls(allToolCalls);

		// Add assistant message to conversation history
		const assistantMsg: Message = {
			role: 'assistant',
			content: cleanedContent,
			tool_calls: validToolCalls.length > 0 ? validToolCalls : undefined,
		};
		setMessages([...messages, assistantMsg]);

		// Update conversation state with assistant message
		conversationStateManager.current.updateAssistantMessage(assistantMsg);

		// Handle tool calls if present - this continues the loop
		if (validToolCalls && validToolCalls.length > 0) {
			// First, validate tools and separate valid from unknown
			const knownToolCalls: ToolCall[] = [];
			const unknownToolErrors: ToolResult[] = [];

			for (const toolCall of validToolCalls) {
				if (!toolManager?.hasTool(toolCall.function.name)) {
					// Create error result for unknown tool
					const errorResult: ToolResult = {
						tool_call_id: toolCall.id,
						role: 'tool' as const,
						name: toolCall.function.name,
						content: `Error: Unknown tool: ${toolCall.function.name}`,
					};
					unknownToolErrors.push(errorResult);

					// Display the error result
					await displayToolResult(toolCall, errorResult);
				} else {
					// Tool exists, add to valid list
					knownToolCalls.push(toolCall);
				}
			}

			// If there were unknown tools, continue conversation with all errors
			if (unknownToolErrors.length > 0) {
				const toolMessages = unknownToolErrors.map(result => ({
					role: 'tool' as const,
					content: result.content || '',
					tool_call_id: result.tool_call_id,
					name: result.name,
				}));

				const updatedMessagesWithError = [
					...messages,
					assistantMsg,
					...toolMessages,
				];

				setMessages(updatedMessagesWithError);

				// Continue the main conversation loop with error messages as context
				await processAssistantResponse(systemMessage, updatedMessagesWithError);
				return;
			}

			// If we get here, all tools are valid - proceed with normal flow
			// Use knownToolCalls for the rest of the processing

			// Separate tools that need confirmation vs those that don't
			const toolsNeedingConfirmation: ToolCall[] = [];
			const toolsToExecuteDirectly: ToolCall[] = [];

			for (const toolCall of knownToolCalls) {
				const toolDef = toolDefinitions.find(
					def => def.config.function.name === toolCall.function.name,
				);

				if (toolDef && toolDef.requiresConfirmation === false) {
					toolsToExecuteDirectly.push(toolCall);
				} else {
					toolsNeedingConfirmation.push(toolCall);
				}
			}

			// Execute non-confirmation tools directly
			if (toolsToExecuteDirectly.length > 0) {
				// Import processToolUse here to avoid circular dependencies
				const {processToolUse} = await import('../../message-handler.js');
				const directResults: ToolResult[] = [];

				for (const toolCall of toolsToExecuteDirectly) {
					try {
						// Double-check tool exists before execution (safety net)
						if (!toolManager?.hasTool(toolCall.function.name)) {
							throw new Error(`Unknown tool: ${toolCall.function.name}`);
						}

						const result = await processToolUse(toolCall);
						directResults.push(result);

						// Update conversation state with tool execution
						conversationStateManager.current.updateAfterToolExecution(
							toolCall,
							result.content,
						);

						// Display the tool result immediately
						await displayToolResult(toolCall, result);
					} catch (error) {
						// Handle tool execution errors
						const errorResult: ToolResult = {
							tool_call_id: toolCall.id,
							role: 'tool' as const,
							name: toolCall.function.name,
							content: `Error: ${
								error instanceof Error ? error.message : String(error)
							}`,
						};
						directResults.push(errorResult);

						// Update conversation state with error
						conversationStateManager.current.updateAfterToolExecution(
							toolCall,
							errorResult.content,
						);

						// Display the error result
						await displayToolResult(toolCall, errorResult);
					}
				}

				// If we have results, continue the conversation with them
				if (directResults.length > 0) {
					// Format tool results as standard tool messages
					const toolMessages = directResults.map(result => ({
						role: 'tool' as const,
						content: result.content || '',
						tool_call_id: result.tool_call_id,
						name: result.name,
					}));

					const updatedMessagesWithTools = [
						...messages,
						assistantMsg,
						...toolMessages,
					];

					setMessages(updatedMessagesWithTools);

					// Continue the main conversation loop with tool results as context
					await processAssistantResponse(
						systemMessage,
						updatedMessagesWithTools,
					);
					return;
				}
			}

			// Start confirmation flow only for tools that need it
			if (toolsNeedingConfirmation.length > 0) {
				onStartToolConfirmationFlow(
					toolsNeedingConfirmation,
					messages,
					assistantMsg,
					systemMessage,
				);
				return; // IMPORTANT: Stop processing here, wait for user confirmation
			}
		}
	};

	// Process assistant response - handles the conversation loop with potential tool calls (for follow-ups)
	const processAssistantResponse = async (
		systemMessage: Message,
		messages: Message[],
	) => {
		if (!client) return;

		// Ensure we have an abort controller for this request
		let controller = abortController;
		if (!controller) {
			controller = new AbortController();
			setAbortController(controller);
		}

		try {
			setIsThinking(true);

			const stream = client.chatStream(
				[systemMessage, ...messages],
				toolManager?.getAllTools() || [],
			);

			let toolCalls: any = null;
			let fullContent = '';
			let hasContent = false;
			let tokenCount = 0;

			// Process streaming response with progress updates and cancellation support
			const cancellableStream = makeCancellableStream(
				stream,
				controller.signal,
			);
			for await (const chunk of cancellableStream) {
				hasContent = true;

				if (chunk.message?.content) {
					fullContent += chunk.message.content;
					tokenCount = Math.ceil(fullContent.length / 4);
				}

				// If server provides eval_count, use it as it's more accurate
				// But ensure we don't reset to a lower count if content tokens are higher
				if (chunk.eval_count) {
					tokenCount = Math.max(tokenCount, chunk.eval_count);
				}

				if (chunk.message?.tool_calls) {
					toolCalls = chunk.message.tool_calls;
				}

				// Update thinking stats in real-time (similar to initial response)
				if (!chunk.done) {
					const systemTokens = Math.ceil(systemMessage.content.length / 4); // Use actual system prompt length
					const conversationTokens = getMessageTokens
						? messages.reduce((total, msg) => total + getMessageTokens(msg), 0)
						: messages.reduce(
								(total, msg) =>
									total + Math.ceil((msg.content?.length || 0) / 4),
								0,
						  );
					const totalTokensUsed =
						systemTokens + conversationTokens + tokenCount;

					throttledSetThinkingStats({
						tokenCount,
						contextSize: client.getContextSize(),
						totalTokensUsed,
						tokensPerSecond: chunk.tokens_per_second,
					});
				}
			}

			if (!hasContent) {
				throw new Error('No response received from model');
			}

			// Parse any tool calls from content for non-tool-calling models
			const parsedToolCalls = parseToolCallsFromContent(fullContent);
			const cleanedContent = cleanContentFromToolCalls(
				fullContent,
				parsedToolCalls,
			);

			// Display the assistant response (cleaned of any tool calls)
			if (cleanedContent.trim()) {
				addToChatQueue(
					<AssistantMessage
						key={`assistant-${componentKeyCounter}`}
						message={cleanedContent}
						model={currentModel}
					/>,
				);
			}

			// Merge structured tool calls from LangGraph with content-parsed tool calls
			const allToolCalls = [...(toolCalls || []), ...parsedToolCalls];
			const validToolCalls = filterValidToolCalls(allToolCalls);

			// Add assistant message to conversation history
			const assistantMsg: Message = {
				role: 'assistant',
				content: cleanedContent,
				tool_calls: validToolCalls.length > 0 ? validToolCalls : undefined,
			};
			setMessages([...messages, assistantMsg]);

			// Update conversation state with assistant message
			conversationStateManager.current.updateAssistantMessage(assistantMsg);

			// Handle tool calls if present - this continues the loop
			if (validToolCalls && validToolCalls.length > 0) {
				// Separate tools that need confirmation vs those that don't
				const toolsNeedingConfirmation: ToolCall[] = [];
				const toolsToExecuteDirectly: ToolCall[] = [];

				for (const toolCall of validToolCalls) {
					const toolDef = toolDefinitions.find(
						def => def.config.function.name === toolCall.function.name,
					);
					if (toolDef && toolDef.requiresConfirmation === false) {
						toolsToExecuteDirectly.push(toolCall);
					} else {
						toolsNeedingConfirmation.push(toolCall);
					}
				}

				// Execute non-confirmation tools directly
				if (toolsToExecuteDirectly.length > 0) {
					// Import processToolUse here to avoid circular dependencies
					const {processToolUse} = await import('../../message-handler.js');
					const directResults: ToolResult[] = [];

					for (const toolCall of toolsToExecuteDirectly) {
						try {
							const result = await processToolUse(toolCall);
							directResults.push(result);

							// Update conversation state with tool execution
							conversationStateManager.current.updateAfterToolExecution(
								toolCall,
								result.content,
							);

							// Display the tool result immediately
							await displayToolResult(toolCall, result);
						} catch (error) {
							// Handle tool execution errors
							const errorResult: ToolResult = {
								tool_call_id: toolCall.id,
								role: 'tool' as const,
								name: toolCall.function.name,
								content: `Error: ${
									error instanceof Error ? error.message : String(error)
								}`,
							};
							directResults.push(errorResult);

							// Update conversation state with error
							conversationStateManager.current.updateAfterToolExecution(
								toolCall,
								errorResult.content,
							);

							// Display the error result
							await displayToolResult(toolCall, errorResult);
						}
					}

					// If we have results, continue the conversation with them
					if (directResults.length > 0) {
						// Format tool results as standard tool messages
						const toolMessages = directResults.map(result => ({
							role: 'tool' as const,
							content: result.content || '',
							tool_call_id: result.tool_call_id,
							name: result.name,
						}));

						const updatedMessagesWithTools = [
							...messages,
							assistantMsg,
							...toolMessages,
						];
						setMessages(updatedMessagesWithTools);

						// Continue the main conversation loop with tool results as context
						const controller = new AbortController();
						await processAssistantResponseWithTokenTracking(
							systemMessage,
							updatedMessagesWithTools,
							controller,
						);
						return;
					}
				}

				// Start confirmation flow only for tools that need it
				if (toolsNeedingConfirmation.length > 0) {
					onStartToolConfirmationFlow(
						toolsNeedingConfirmation,
						messages,
						assistantMsg,
						systemMessage,
					);
				}
			}
			// If no tool calls, the conversation naturally ends here
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === 'Operation was cancelled'
			) {
				addToChatQueue(
					<ErrorMessage
						key={`cancelled-${componentKeyCounter}`}
						message="Operation was cancelled by user"
						hideBox={true}
					/>,
				);
			} else {
				addToChatQueue(
					<ErrorMessage
						key={`error-${componentKeyCounter}`}
						message={`Conversation error: ${error}`}
					/>,
				);
			}
		} finally {
			setIsThinking(false);
			setIsCancelling(false);
			setAbortController(null);
		}
	};

	// Handle chat message processing
	const handleChatMessage = async (message: string) => {
		if (!client || !toolManager) return;

		// Process file references in the message
		const {processedMessage, fileReferences, includedContent} =
			parseFileReferences(message);

		// Display file reference errors if any
		const errorReferences = fileReferences.filter(
			ref => !ref.exists && ref.error,
		);
		if (errorReferences.length > 0) {
			for (const errorRef of errorReferences) {
				addToChatQueue(
					<ErrorMessage
						key={`file-error-${componentKeyCounter}-${errorRef.originalPattern}`}
						message={`File reference error: ${errorRef.originalPattern} - ${errorRef.error}`}
						hideBox={true}
					/>,
				);
			}
		}

		// Display included files information
		const validReferences = fileReferences.filter(ref => ref.exists);
		if (validReferences.length > 0) {
			const fileNames = validReferences
				.map(ref => {
					const lineInfo = ref.startLine
						? `:${ref.startLine}${ref.endLine ? `-${ref.endLine}` : ''}`
						: '';
					return `${ref.filePath}${lineInfo}`;
				})
				.join(', ');

			addToChatQueue(
				<ToolMessage
					key={`file-inclusion-${componentKeyCounter}`}
					title={`📎 Included files`}
					message={`Added context from: ${fileNames}`}
					hideBox={true}
				/>,
			);
		}

		// Add user message to chat (show processed message for cleaner display)
		addToChatQueue(
			<UserMessage
				key={`user-${componentKeyCounter}`}
				message={processedMessage}
			/>,
		);

		// Build enhanced message content with file contents
		let enhancedContent = processedMessage;
		if (includedContent.length > 0) {
			const fileContents = includedContent
				.map((content, index) => {
					const ref = validReferences[index];
					const lineInfo = ref?.startLine
						? ` (lines ${ref.startLine}${ref.endLine ? `-${ref.endLine}` : ''})`
						: '';
					return `\n\n---\nFile: ${
						ref?.filePath || 'unknown'
					}${lineInfo}\n\`\`\`\n${content}\n\`\`\``;
				})
				.join('');

			enhancedContent = processedMessage + fileContents;
		}

		// Add enhanced user message to conversation history
		const userMessage: Message = {role: 'user', content: enhancedContent};
		const updatedMessages = [...messages, userMessage];
		setMessages(updatedMessages);

		// Initialize conversation state if this is a new conversation
		if (messages.length === 0) {
			conversationStateManager.current.initializeState(message);
		}

		// Create abort controller for cancellation
		const controller = new AbortController();
		setAbortController(controller);

		// Start thinking indicator and streaming
		setIsThinking(true);

		// Initialize per-message stats with existing conversation context
		// const systemTokens = Math.ceil(systemPrompt.length / 4); // Comment out, will calculate later
		const existingConversationTokens = getMessageTokens
			? updatedMessages.reduce((total, msg) => total + getMessageTokens(msg), 0)
			: updatedMessages.reduce(
					(total, msg) => total + Math.ceil((msg.content?.length || 0) / 4),
					0,
			  );

		try {
			// Load and process system prompt with dynamic tool documentation
			const availableTools = toolManager ? toolManager.getAllTools() : [];
			const systemPrompt = processPromptTemplate(availableTools);

			// Create stream request
			const systemMessage: Message = {
				role: 'system',
				content: systemPrompt,
			};

			// Use the new conversation loop
			// Initialize per-message stats with actual system prompt tokens
			const systemTokens = Math.ceil(systemMessage.content.length / 4);
			setThinkingStats({
				tokenCount: 0,
				contextSize: client.getContextSize(),
				totalTokensUsed: systemTokens + existingConversationTokens,
			});

			// Use the new conversation loop
			await processAssistantResponseWithTokenTracking(
				systemMessage,
				updatedMessages,
				controller,
			);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === 'Operation was cancelled'
			) {
				addToChatQueue(
					<ErrorMessage
						key={`cancelled-${componentKeyCounter}`}
						message="Operation was cancelled by user"
						hideBox={true}
					/>,
				);
			} else {
				addToChatQueue(
					<ErrorMessage
						key={`error-${componentKeyCounter}`}
						message={`Chat error: ${error}`}
					/>,
				);
			}
		} finally {
			setIsThinking(false);
			setIsCancelling(false);
			setAbortController(null);
		}
	};

	return {
		handleChatMessage,
		processAssistantResponse,
	};
}
