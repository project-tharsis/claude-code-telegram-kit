import { MODEL_CANCEL_LABEL, MODEL_REPLY_CHOICES } from "./control-command.js";

export const MODEL_REPLY_KEYBOARD = {
  keyboard: [
    MODEL_REPLY_CHOICES.slice(0, 2).map(choice => ({ text: choice.label })),
    MODEL_REPLY_CHOICES.slice(2).map(choice => ({ text: choice.label })),
    [{ text: MODEL_CANCEL_LABEL }]
  ],
  resize_keyboard: true,
  one_time_keyboard: true,
  input_field_placeholder: "Choose a model"
};

export const REMOVE_MODEL_REPLY_KEYBOARD = {
  remove_keyboard: true
};
