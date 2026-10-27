// 成功用 fixture を明示し忘れても実サービスへ接続しない。
globalThis.fetch = async () => {
	throw new Error("test: external fetch denied");
};
