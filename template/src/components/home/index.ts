import { HomeCards } from "./HomeCards";
import { HomeEditorial } from "./HomeEditorial";
import { HomeFocus } from "./HomeFocus";
import { HomeList } from "./HomeList";
import { HomeSplit } from "./HomeSplit";

/** The five home patterns, by the name HOME_STYLE uses in src/lib/theme.ts. */
export const HOME_PATTERNS = {
  focus: HomeFocus,
  split: HomeSplit,
  editorial: HomeEditorial,
  cards: HomeCards,
  list: HomeList,
} as const;

export type HomePattern = keyof typeof HOME_PATTERNS;
