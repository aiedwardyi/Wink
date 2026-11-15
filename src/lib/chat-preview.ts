import { createContext, useContext } from "react";

export const CHAT_PEEK_WINDOW_SIZE = 4;
export const ChatPreviewContext = createContext(false);
export const useChatPreview = () => useContext(ChatPreviewContext);
