import { MODEL_REPLY_CHOICES } from "./control-command.js";

export const MODEL_REPLY_KEYBOARD = {
  keyboard: MODEL_REPLY_CHOICES.map(choice => [{ text: choice.label }]),
  resize_keyboard: true,
  one_time_keyboard: true,
  input_field_placeholder: "Choose a model"
};

export const REMOVE_MODEL_REPLY_KEYBOARD = {
  remove_keyboard: true
};
