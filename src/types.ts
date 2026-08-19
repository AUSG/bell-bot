export interface GroupIdentity {
  id: number;
  name: string;
}

export interface GroupSummary extends GroupIdentity {
  memberCount: number;
}

export interface Group {
  id: number;
  name: string;
  members: string[];
}

export type BellCommand =
  | { type: "help" }
  | { type: "list_groups" }
  | {
      type: "group_request";
      groupText: string;
      allowPrefixMatch: boolean;
    };

export interface SlackPlainText {
  type: "plain_text";
  text: string;
  emoji?: boolean;
}

export interface SlackMrkdwnText {
  type: "mrkdwn";
  text: string;
}

export type SlackText = SlackPlainText | SlackMrkdwnText;

export interface SlackOption {
  text: SlackPlainText;
  value: string;
}

export interface SlackStaticSelect {
  type: "static_select";
  action_id: string;
  placeholder: SlackPlainText;
  options: SlackOption[];
  initial_option?: SlackOption;
}

export interface SlackButton {
  type: "button";
  action_id: string;
  text: SlackPlainText;
  value: string;
  style?: "danger" | "primary";
  confirm?: {
    title: SlackPlainText;
    text: SlackPlainText;
    confirm: SlackPlainText;
    deny: SlackPlainText;
    style?: "danger" | "primary";
  };
}

export interface SlackPlainTextInput {
  type: "plain_text_input";
  action_id: string;
  initial_value?: string;
  placeholder?: SlackPlainText;
}

export interface SlackMultiUsersSelect {
  type: "multi_users_select";
  action_id: string;
  placeholder: SlackPlainText;
  initial_users?: string[];
  max_selected_items?: number;
}

export type SlackBlock =
  | {
      type: "header";
      text: SlackPlainText;
    }
  | {
      type: "section";
      text: SlackText;
      accessory?: SlackStaticSelect | SlackButton;
    }
  | {
      type: "input";
      block_id: string;
      label: SlackPlainText;
      element: SlackPlainTextInput | SlackMultiUsersSelect;
      optional?: boolean;
    }
  | {
      type: "context";
      elements: SlackText[];
    }
  | {
      type: "divider";
    };

export interface SlackMessage {
  text: string;
  blocks: SlackBlock[];
}

export interface SlackModalView {
  type: "modal";
  callback_id: string;
  private_metadata: string;
  title: SlackPlainText;
  submit: SlackPlainText;
  close: SlackPlainText;
  blocks: SlackBlock[];
}
