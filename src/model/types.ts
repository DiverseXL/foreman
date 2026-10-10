export type ModelTask = "patch" | "validate" | "cheap";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ModelCallResult = {
  text: string;
  model: string;
  task: ModelTask;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
};
