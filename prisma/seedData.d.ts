export declare const tag: {
    id: number;
    name: string;
    icon: string;
    parent: number;
}[];
export declare const attachments: any;
export declare const notes: {
    id: number;
    type: number;
    content: string;
    isArchived: boolean;
    isRecycle: boolean;
    isTop: boolean;
}[];
export declare const tagsToNote: {
    id: number;
    noteId: number;
    tagId: number;
}[];
export declare function createSeed(accountId: number, workspaceId?: number): Promise<void>;
