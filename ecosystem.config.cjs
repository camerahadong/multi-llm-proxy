module.exports = {
  apps: [
    {
      name: 'multi-llm-proxy',
      script: 'src/main.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '1G',
      kill_timeout: 10000,
      listen_timeout: 10000,
      wait_ready: false,
    },
  ],
};
