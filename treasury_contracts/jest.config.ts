import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testPathIgnorePatterns: ['/node_modules/', 'external', '/dist/'],
    testTimeout: 10000000
};

export default config;
