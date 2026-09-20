"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = __importDefault(require("node:assert"));
const sinon_1 = __importDefault(require("sinon"));
const MiniMaxEmbeddings_1 = require("./MiniMaxEmbeddings");
describe('MiniMaxEmbeddings', () => {
    let sandbox;
    let fetchStub;
    function makeFetchResponse(status, data, statusText = '') {
        return {
            status,
            statusText,
            ok: status >= 200 && status < 300,
            headers: new Headers(),
            json: () => __awaiter(this, void 0, void 0, function* () { return data; }),
            text: () => __awaiter(this, void 0, void 0, function* () { return JSON.stringify(data); }),
        };
    }
    const successData = {
        vectors: [[0.1, 0.2], [0.3, 0.4]],
        total_tokens: 64,
        base_resp: { status_code: 0, status_msg: '' },
    };
    beforeEach(() => {
        sandbox = sinon_1.default.createSandbox();
        fetchStub = sandbox.stub(globalThis, 'fetch');
    });
    afterEach(() => {
        sandbox.restore();
    });
    it('applies defaults and trims trailing slash from endpoint', () => {
        const inst = new MiniMaxEmbeddings_1.MiniMaxEmbeddings({ apiKey: 'key', endpoint: 'https://api.minimax.cn/' });
        node_assert_1.default.strictEqual(inst.options.endpoint, 'https://api.minimax.cn');
        node_assert_1.default.strictEqual(inst.options.model, 'embo-01');
        node_assert_1.default.strictEqual(inst.model, 'embo-01');
        node_assert_1.default.strictEqual(inst.maxTokens, 500);
        node_assert_1.default.deepStrictEqual(inst.options.retryPolicy, [2000, 5000]);
    });
    it('respects overrides for model and maxTokens', () => {
        const inst = new MiniMaxEmbeddings_1.MiniMaxEmbeddings({
            apiKey: 'key',
            endpoint: 'https://api.minimaxi.com',
            model: 'custom-model',
            maxTokens: 1234,
        });
        node_assert_1.default.strictEqual(inst.options.endpoint, 'https://api.minimaxi.com');
        node_assert_1.default.strictEqual(inst.model, 'custom-model');
        node_assert_1.default.strictEqual(inst.maxTokens, 1234);
    });
    it('sends query type for string input and returns vectors', () => __awaiter(void 0, void 0, void 0, function* () {
        fetchStub.resolves(makeFetchResponse(200, {
            vectors: [[0.1, 0.2]],
            total_tokens: 8,
            base_resp: { status_code: 0, status_msg: '' },
        }));
        const inst = new MiniMaxEmbeddings_1.MiniMaxEmbeddings({ apiKey: 'sk-test' });
        const result = yield inst.createEmbeddings('什么是向量数据库？');
        node_assert_1.default.strictEqual(fetchStub.callCount, 1);
        const [url, init] = fetchStub.firstCall.args;
        node_assert_1.default.strictEqual(url, 'https://api.minimax.cn/v1/embeddings');
        node_assert_1.default.strictEqual(init.headers.get('Authorization'), 'Bearer sk-test');
        node_assert_1.default.deepStrictEqual(JSON.parse(init.body), {
            model: 'embo-01',
            texts: ['什么是向量数据库？'],
            type: 'query',
        });
        node_assert_1.default.strictEqual(result.status, 'success');
        node_assert_1.default.deepStrictEqual(result.output, [[0.1, 0.2]]);
        node_assert_1.default.strictEqual(result.model, 'embo-01');
        node_assert_1.default.deepStrictEqual(result.usage, { total_tokens: 8 });
    }));
    it('sends db type for array input', () => __awaiter(void 0, void 0, void 0, function* () {
        fetchStub.resolves(makeFetchResponse(200, successData));
        const inst = new MiniMaxEmbeddings_1.MiniMaxEmbeddings({ apiKey: 'sk-test' });
        const result = yield inst.createEmbeddings(['chunk one', 'chunk two']);
        const [, init] = fetchStub.firstCall.args;
        node_assert_1.default.deepStrictEqual(JSON.parse(init.body), {
            model: 'embo-01',
            texts: ['chunk one', 'chunk two'],
            type: 'db',
        });
        node_assert_1.default.strictEqual(result.status, 'success');
        node_assert_1.default.deepStrictEqual(result.output, [[0.1, 0.2], [0.3, 0.4]]);
    }));
    it('reports API errors that arrive with an HTTP 200 status', () => __awaiter(void 0, void 0, void 0, function* () {
        fetchStub.resolves(makeFetchResponse(200, {
            base_resp: { status_code: 2013, status_msg: 'invalid params' },
        }));
        const inst = new MiniMaxEmbeddings_1.MiniMaxEmbeddings({ apiKey: 'sk-test' });
        const result = yield inst.createEmbeddings('hello');
        node_assert_1.default.strictEqual(result.status, 'error');
        node_assert_1.default.ok((result.message || '').includes('2013'));
        node_assert_1.default.ok((result.message || '').includes('invalid params'));
    }));
    it('reports HTTP errors without base_resp using the response status', () => __awaiter(void 0, void 0, void 0, function* () {
        fetchStub.resolves(makeFetchResponse(503, {}, 'Service Unavailable'));
        const inst = new MiniMaxEmbeddings_1.MiniMaxEmbeddings({ apiKey: 'sk-test' });
        const result = yield inst.createEmbeddings('hello');
        node_assert_1.default.strictEqual(result.status, 'error');
        node_assert_1.default.ok((result.message || '').includes('503'));
    }));
    it('429 retry path obeys retryPolicy delays and eventually succeeds', () => __awaiter(void 0, void 0, void 0, function* () {
        const clock = sandbox.useFakeTimers();
        const resp429 = makeFetchResponse(429, {});
        const resp200 = makeFetchResponse(200, {
            vectors: [[0.1]],
            base_resp: { status_code: 0, status_msg: '' },
        });
        fetchStub.onCall(0).resolves(resp429);
        fetchStub.onCall(1).resolves(resp429);
        fetchStub.onCall(2).resolves(resp200);
        const inst = new MiniMaxEmbeddings_1.MiniMaxEmbeddings({ apiKey: 'sk-test', retryPolicy: [10, 20] });
        const p = inst.createEmbeddings('x');
        yield clock.tickAsync(10);
        yield clock.tickAsync(20);
        const result = yield p;
        node_assert_1.default.strictEqual(fetchStub.callCount, 3);
        node_assert_1.default.strictEqual(result.status, 'success');
        clock.restore();
    }));
    it('429 with empty retryPolicy returns rate_limited', () => __awaiter(void 0, void 0, void 0, function* () {
        fetchStub.resolves(makeFetchResponse(429, {}));
        const inst = new MiniMaxEmbeddings_1.MiniMaxEmbeddings({ apiKey: 'sk-test', retryPolicy: [] });
        const result = yield inst.createEmbeddings('x');
        node_assert_1.default.strictEqual(result.status, 'rate_limited');
        node_assert_1.default.ok((result.message || '').includes('rate limit'));
    }));
});
//# sourceMappingURL=MiniMaxEmbeddings.spec.js.map