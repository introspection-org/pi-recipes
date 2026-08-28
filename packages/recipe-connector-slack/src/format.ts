export interface SlackMessageBody {
  text: string;
  blocks: Array<{ type: "markdown"; text: string }>;
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
    blocks: [{ type: "markdown", text: markdown }],
  };
}
