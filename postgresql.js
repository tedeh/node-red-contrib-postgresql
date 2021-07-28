'use strict';

/**
 * Return an incoming node ID if the node has any input wired to it, false otherwise.
 * If filter callback is not null, then this function filters incoming nodes.
 * @param {Object} toNode
 * @param {function} filter
 * @return {(number|boolean)}
 */
function findInputNodeId(toNode, filter = null) {
	if (toNode && toNode._flow && toNode._flow.global) {
		const allNodes = toNode._flow.global.allNodes;
		for (const fromNodeId of Object.keys(allNodes)) {
			const fromNode = allNodes[fromNodeId];
			if (fromNode.wires) {
				for (const wireId of Object.keys(fromNode.wires)) {
					const wire = fromNode.wires[wireId];
					for (const toNodeId of wire) {
						if (toNode.id === toNodeId && (!filter || filter(fromNode))) {
							return fromNode.id;
						}
					}
				}
			}
		}
	}
	return false;
}

module.exports = function (RED) {
	const mustache = require('mustache');
	const Cursor = require('pg-cursor');
	const Pool = require('pg').Pool;

	function getField(node, kind, value) {
		switch (kind) {
		case 'flow':
			return node.context().flow.get(value);
		case 'global':
			return node.context().global.get(value);
		case 'num':
			return parseInt(value);
		case 'bool':
			return JSON.parse(value);
		default:
			return value;
		}
	}

	function PostgresDBNode(n) {
		const node = this;
		RED.nodes.createNode(node, n);
		node.name = n.name;
		node.host = n.host;
		node.hostFieldType = n.hostFieldType;
		node.port = n.port;
		node.portFieldType = n.portFieldType;
		node.database = n.database;
		node.databaseFieldType = n.databaseFieldType;
		node.ssl = n.ssl;
		node.sslFieldType = n.sslFieldType;
		node.max = n.max;
		node.maxFieldType = n.maxFieldType;
		node.min = n.min;
		node.minFieldType = n.minFieldType;
		node.idle = n.idle;
		node.idleFieldType = n.idleFieldType;
		node.user = n.user;
		node.userFieldType = n.userFieldType;
		node.password = n.password;
		node.passwordFieldType = n.passwordFieldType;
		node.connectionTimeout = n.connectionTimeout;
		node.connectionTimeoutFieldType = n.connectionTimeoutFieldType;

		this.pgPool = new Pool({
			user: getField(node, n.userFieldType, n.user),
			password: getField(node, n.passwordFieldType, n.password),
			host: getField(node, n.hostFieldType, n.host),
			port: getField(node, n.portFieldType, n.port),
			database: getField(node, n.databaseFieldType, n.database),
			ssl: getField(node, n.sslFieldType, n.ssl),
			max: getField(node, n.maxFieldType, n.max),
			min: getField(node, n.minFieldType, n.min),
			idleTimeoutMillis: getField(node, n.idleFieldType, n.idle),
			connectionTimeoutMillis: getField(node, n.connectionTimeoutFieldType, n.connectionTimeout),
		});
	}

	RED.nodes.registerType('postgresDB', PostgresDBNode);

	function PostgreSQLNode(config) {
		const node = this;
		RED.nodes.createNode(node, config);
		node.topic = config.topic;
		node.query = config.query;
		node.split = config.split;
		node.rowsPerMsg = config.rowsPerMsg;
		node.config = RED.nodes.getNode(config.postgresDB);

		// Declare the ability of this node to provide ticks upstream for back-pressure
		node.tickProvider = true;
		let tickUpstreamId;
		let tickUpstreamNode;
		let upstreamPartsId = '';

		// Declare the ability of this node to consume ticks from downstream for back-pressure
		node.tickConsumer = true;
		let downstreamReady = true;

		// For streaming from PostgreSQL
		let cursor;
		let getNextRows;

		node.on('input', async (msg) => {
			if (tickUpstreamId === undefined) {
				tickUpstreamId = findInputNodeId(node, (n) => RED.nodes.getNode(n.id).tickConsumer);
				tickUpstreamNode = tickUpstreamId ? RED.nodes.getNode(tickUpstreamId) : null;
			}

			if (msg.tick) {
				downstreamReady = true;
				if (getNextRows) {
					getNextRows();
				}
			} else {
				const query = mustache.render(node.query, { msg });

				let client = null;

				const handleDone = () => {
					if (cursor) {
						cursor.close();
						cursor = null;
					}
					if (client) {
						client.release(true);
						client = null;
					}
					getNextRows = null;
				};

				const handleError = (err) => {
					console.error(err);
					const error = (err ? err.toString() : 'Unknown error!') + ' ' + query;
					node.error(error);
					handleDone();
					msg.payload = error;
					msg.parts = {
						id: upstreamPartsId,
						abort: true,
					};
					downstreamReady = false;
					node.send(msg);
				};

				handleDone();
				upstreamPartsId = (msg.parts && msg.parts.id) || '' + Math.random();
				downstreamReady = true;

				try {
					client = await node.config.pgPool.connect();

					if (node.split) {
						let partsIndex = 0;
						cursor = client.query(new Cursor(query, msg.params || []));
						const cursorcallback = (err, rows) => {
							if (err) {
								handleError(err);
							} else if (rows.length > 0) {
								downstreamReady = false;
								node.send(Object.assign({}, msg, {
									payload: (node.rowsPerMsg || 1) > 1 ? rows : rows[0],
									parts: {
										id: upstreamPartsId,
										type: 'array',
										index: partsIndex,
									},
								}));
								partsIndex++;
								getNextRows();
							} else {
								// Complete
								handleDone();

								downstreamReady = false;
								node.send(Object.assign({}, msg, {
									payload: [],
									parts: {
										id: upstreamPartsId,
										type: 'array',
										index: partsIndex,
										count: partsIndex + 1,
									},
									complete: true,
								}));
								if (tickUpstreamNode) {
									tickUpstreamNode.receive({ tick: true });
								}
							}
						};

						getNextRows = () => {
							if (downstreamReady) {
								cursor.read(node.rowsPerMsg || 1, cursorcallback);
							}
						};
					} else {
						getNextRows = async () => {
							try {
								msg.payload = await client.query(query, msg.params || []);
								handleDone();
								downstreamReady = false;
								node.send(msg);
								if (tickUpstreamNode) {
									tickUpstreamNode.receive({ tick: true });
								}
							} catch (ex) {
								handleError(ex);
							}
						};
					}

					getNextRows();
				} catch (err) {
					handleError(err);
				}
			}
		});

		node.on('close', () => node.status({}));
	}

	RED.nodes.registerType('postgresql', PostgreSQLNode);
};