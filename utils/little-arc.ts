export type LittleArcMessage =
  | { type: 'little-arc:open'; url: string }
  | { type: 'little-arc:get-tab-pinned-state' };

export type LittleArcTabStateMessage = {
  type: 'little-arc:tab-pinned-state';
  pinned: boolean;
};
