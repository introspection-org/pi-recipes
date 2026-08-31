export interface SlackMessageBody {
  text: string;
  blocks: Array<{ type: "markdown"; text: string }>;
}

const SLACK_MARKDOWN_BLOCK_MAX_LENGTH = 12_000;
const SLACK_MESSAGE_MAX_BLOCKS = 50;

export function markdownBlocks(
  markdown: string,
): Array<{ type: "markdown"; text: string }> {
  const codePoints = Array.from(markdown);
  if (
    codePoints.length >
    SLACK_MARKDOWN_BLOCK_MAX_LENGTH * SLACK_MESSAGE_MAX_BLOCKS
  ) {
    throw new RangeError(
      "Slack Markdown exceeds the 50 block limit for one message",
    );
  }
  if (codePoints.length === 0) {
    return [{ type: "markdown", text: "" }];
  }
  const blocks: Array<{ type: "markdown"; text: string }> = [];
  for (
    let offset = 0;
    offset < codePoints.length;
    offset += SLACK_MARKDOWN_BLOCK_MAX_LENGTH
  ) {
    blocks.push({
      type: "markdown",
      text: codePoints
        .slice(offset, offset + SLACK_MARKDOWN_BLOCK_MAX_LENGTH)
        .join(""),
    });
  }
  return blocks;
}

export function toPlainText(markdown: string): string {
  let text = markdown;
  text = text.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, "$1");
  text = text.replace(/`([^`\n]+)`/g, "$1");
  text = text.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_match, label, url) =>
    label ? label : url,
  );
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(?<![*_\w])[*_]([^*_\n]+)[*_](?![*_\w])/g, "$1");
  text = text.replace(/~~(.*?)~~/g, "$1");
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, "• ");
  return text.trim();
}

export function slackMessageBody(
  markdown: string,
  options: { plainText?: string } = {},
): SlackMessageBody {
  return {
    text: options.plainText?.trim() || toPlainText(markdown),
    blocks: markdownBlocks(markdown),
  };
}
