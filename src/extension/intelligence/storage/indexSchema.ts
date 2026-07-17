export const INDEX_SCHEMA_V1 = `
CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT NOT NULL, uri TEXT NOT NULL UNIQUE, language_id TEXT NOT NULL, content_hash TEXT NOT NULL, byte_length INTEGER NOT NULL, mtime INTEGER NOT NULL, index_state TEXT NOT NULL, extractor_ver INTEGER NOT NULL, chunker_ver INTEGER NOT NULL, indexed_at INTEGER NOT NULL);
CREATE TABLE nodes (id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE, semantic_key TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, start_column INTEGER, end_column INTEGER, signature TEXT, exported INTEGER NOT NULL DEFAULT 0, content_hash TEXT NOT NULL, metadata_json TEXT);
CREATE TABLE chunks (id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE, node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL, semantic_key TEXT NOT NULL, chunk_kind TEXT NOT NULL, source_text TEXT NOT NULL, search_text TEXT NOT NULL, embedding_text TEXT NOT NULL, source_hash TEXT NOT NULL, search_hash TEXT NOT NULL, embedding_hash TEXT NOT NULL, start_line INTEGER, end_line INTEGER, token_hint INTEGER, updated_at INTEGER NOT NULL);
CREATE TABLE edges (id TEXT PRIMARY KEY, source_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, owner_chunk_id TEXT REFERENCES chunks(id) ON DELETE CASCADE, kind TEXT NOT NULL, file_id TEXT REFERENCES files(id) ON DELETE CASCADE, line INTEGER, confidence TEXT, metadata_json TEXT);
CREATE VIRTUAL TABLE chunk_fts USING fts5(chunk_id UNINDEXED, search_text, tokenize = 'unicode61');
CREATE TABLE embedding_cache (provider TEXT NOT NULL, model TEXT NOT NULL, embedding_hash TEXT NOT NULL, dim INTEGER NOT NULL, vector_blob BLOB NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(provider, model, embedding_hash));
CREATE TABLE chunk_embeddings (chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE, provider TEXT NOT NULL, model TEXT NOT NULL, embedding_hash TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(chunk_id, provider, model));
CREATE TABLE import_bindings (id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE, owner_chunk_id TEXT REFERENCES chunks(id) ON DELETE CASCADE, imported_name TEXT NOT NULL, local_name TEXT NOT NULL, module_specifier TEXT NOT NULL, resolved_file_id TEXT REFERENCES files(id) ON DELETE SET NULL);
CREATE TABLE unresolved_references (id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE, owner_chunk_id TEXT REFERENCES chunks(id) ON DELETE CASCADE, reference_name TEXT NOT NULL, reference_kind TEXT NOT NULL, line INTEGER, column INTEGER, metadata_json TEXT);
CREATE TABLE file_dependencies (from_file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE, to_file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE, module_specifier TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(from_file_id, to_file_id, module_specifier, kind));
CREATE TABLE diagnostics (id TEXT PRIMARY KEY, file_id TEXT REFERENCES files(id) ON DELETE CASCADE, owner_chunk_id TEXT REFERENCES chunks(id) ON DELETE CASCADE, severity TEXT NOT NULL, code TEXT, message TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE index_jobs (id INTEGER PRIMARY KEY, file_uri TEXT NOT NULL UNIQUE, event_kind TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX idx_nodes_file_id ON nodes(file_id); CREATE INDEX idx_nodes_name ON nodes(name); CREATE INDEX idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX idx_edges_source_node_id ON edges(source_node_id); CREATE INDEX idx_edges_target_node_id ON edges(target_node_id); CREATE INDEX idx_edges_owner_chunk_id ON edges(owner_chunk_id);
CREATE INDEX idx_chunks_file_id ON chunks(file_id); CREATE INDEX idx_chunks_node_id ON chunks(node_id); CREATE INDEX idx_chunks_embedding_hash ON chunks(embedding_hash);
CREATE INDEX idx_file_dependencies_from_file_id ON file_dependencies(from_file_id); CREATE INDEX idx_file_dependencies_to_file_id ON file_dependencies(to_file_id);
CREATE INDEX idx_index_jobs_status_updated_at ON index_jobs(status, updated_at); CREATE INDEX idx_chunk_embeddings_status_updated_at ON chunk_embeddings(status, updated_at);
`;

export const INDEX_SCHEMA_V2_FTS = `
CREATE VIRTUAL TABLE search_index_fts USING fts5(token, node_id UNINDEXED, node_name UNINDEXED, qualified_name UNINDEXED, file_path UNINDEXED, node_kind UNINDEXED, weight, tokenize = 'unicode61');
CREATE TABLE search_node_metadata (node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE, kind TEXT NOT NULL, scope TEXT NOT NULL, file_priority INTEGER NOT NULL DEFAULT 0, definition_match INTEGER NOT NULL DEFAULT 0);
CREATE TABLE search_file_metadata (file_uri TEXT PRIMARY KEY, content_hash TEXT NOT NULL, indexed_at INTEGER NOT NULL);
CREATE INDEX idx_search_node_metadata_kind ON search_node_metadata(kind);
`;
