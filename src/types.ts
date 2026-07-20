export type Role = "user" | "assistant";
export type VoiceStatus =
  "idle" | "listening" | "thinking" | "speaking" | "error";

export type ChatMessage = {
  id: string;
  role: Role;
  text: string;
  createdAt: string;
  language?: string;
};

export type ChatResult = {
  assistantText: string;
  audio: string;
  mimeType: string;
  transcript?: string;
  language?: string;
};
