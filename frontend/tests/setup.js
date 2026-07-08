import { Window } from 'happy-dom';

const happyWindow = new Window();
globalThis.localStorage = happyWindow.localStorage;
