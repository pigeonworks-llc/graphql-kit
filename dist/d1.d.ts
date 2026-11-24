export interface D1Like {
    prepare(sql: string): {
        bind(...values: unknown[]): {
            first<T>(): Promise<T | null>;
            run(): Promise<unknown>;
        };
    };
}
