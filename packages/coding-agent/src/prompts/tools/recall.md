Search your session history for relevant past context. Use when you need to recall something you did, read, or discussed earlier in this session. Returns the most relevant past messages and tool results matching your query.

<instruction>
- Describe what you're looking for naturally: the file, decision, error, or event
- Use `role` filter to narrow results (e.g., `tool_result` for file contents you read)
- Default returns 5 results; increase `limit` for broader searches (max 20)
- Results are diversity-ranked to avoid repetitive matches
</instruction>

<output>
Returns matching session history entries with turn number, role, tool name, referenced paths, and full content.
</output>