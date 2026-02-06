# Fixtures

Test fixtures for the Arkade assets library. Each JSON has **valid** and/or **invalid** cases for serialization, parsing, and transaction validation.

| File | Description |
|------|-------------|
| [asset_group_fixtures.json](asset_group_fixtures.json) | Full asset groups: send, refresh, issuance (with/without metadata, control ref by group or id), reissuance, burn. Round-trip + invalid empty group. |
| [asset_id_fixtures.json](asset_id_fixtures.json) | Asset ID (txid + index): valid edge cases (zero/max index, overflow/underflow); invalid txid/format/length. |
| [asset_input_fixtures.json](asset_input_fixtures.json) | Asset inputs (local vs intent): single/many; invalid txid, type, mixed types, duplicated vin. |
| [asset_output_fixtures.json](asset_output_fixtures.json) | Asset outputs (vout + amount): single/many; invalid format, zero amount, duplicated vout. |
| [asset_ref_fixtures.json](asset_ref_fixtures.json) | Asset ref by ID or group index: valid ID/group + overflow/underflow; invalid format/type/length. |
| [metadata_fixtures.json](metadata_fixtures.json) | Key-value metadata: valid (simple, JSON, non-ASCII, long/short); invalid empty key/value, bad length. |
| [packet_fixtures.json](packet_fixtures.json) | OP_RETURN packets: build from assets, parse from script/txout, leaf (intent); invalid assets, script, prefix. |
| [subdust_fixtures.json](subdust_fixtures.json) | Subdust packets and tx_outs: valid default; invalid empty packet, missing OP_RETURN. |
| [tx_validation_fixtures.json](tx_validation_fixtures.json) | Full tx validation: valid (no packet, issuance, transfer, reissuance, burn); invalid index/ref/control/amount errors. |
