package io.typefox.elkserver;

import com.google.gson.Gson;
import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.StringWriter;
import java.net.InetSocketAddress;
import java.nio.channels.AsynchronousServerSocketChannel;
import java.nio.channels.AsynchronousSocketChannel;
import java.nio.channels.Channels;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;
import org.eclipse.elk.core.RecursiveGraphLayoutEngine;
import org.eclipse.elk.core.util.BasicProgressMonitor;
import org.eclipse.elk.graph.ElkNode;
import org.eclipse.elk.graph.json.ElkGraphJson;

/**
 * The socket server, in two framings, chosen per connection by its first bytes.
 *
 * Framed: every message, both ways, is the magic {@code GZ10}, the length of the
 * body (4 bytes, big-endian) and the body, gzip-compressed JSON. The server never
 * looks inside a body to find where it ends, so any id is safe. A body that is not
 * gzip fails the connection without an answer.
 *
 * Legacy: concatenated plain JSON objects, found by counting braces (see
 * {@link AbstractElkServer#readGraph}).
 *
 * Host and port: the {@code elk.server.host} and {@code elk.server.port} system
 * properties, else the {@code ELK_SERVER_HOST} and {@code ELK_SERVER_PORT}
 * environment variables, else localhost:5008. The server is ready once it logs
 * "ELK Gzip-Framed Server listening on host/address:port".
 */
public class GzipFramedSocketElkServer extends AbstractElkServer {

    private static final Logger LOG = Logger.getLogger(GzipFramedSocketElkServer.class.getName());

    private static final byte[] MAGIC = new byte[] { 'G', 'Z', '1', '0' };
    private static final int HEADER_LEN = 8;

    private int port;
    private String host;

    public GzipFramedSocketElkServer() {
        this.port = Integer.getInteger("elk.server.port",
                Integer.parseInt(System.getenv().getOrDefault("ELK_SERVER_PORT", "5008")));
        this.host = System.getProperty("elk.server.host", System.getenv().getOrDefault("ELK_SERVER_HOST", "localhost"));
    }

    public GzipFramedSocketElkServer(String host, int port) {
        this.host = host;
        this.port = port;
    }

    @Override
    protected void run() throws Exception {
        ExecutorService executor = Executors.newCachedThreadPool();
        InetSocketAddress address = new InetSocketAddress(host, port);
        try (AsynchronousServerSocketChannel serverSocket = AsynchronousServerSocketChannel.open().bind(address)) {
            LOG.info("ELK Gzip-Framed Server listening on " + address);
            int clientSeq = 0;
            while (true) {
                AsynchronousSocketChannel channel = serverSocket.accept().get();
                int clientNo = clientSeq++;
                LOG.info("[" + clientNo + "] Accepted connection");
                executor.submit(() -> {
                    try {
                        handleConnection(channel, clientNo);
                        LOG.info("[" + clientNo + "] Closed connection");
                    } catch (Throwable t) {
                        LOG.log(Level.SEVERE, "[" + clientNo + "] Error: " + t.getMessage(), t);
                    }
                });
            }
        } finally {
            executor.shutdown();
        }
    }

    private void handleConnection(AsynchronousSocketChannel channel, int clientNo) throws Exception {
        InputStream rawIn = Channels.newInputStream(channel);
        OutputStream out = Channels.newOutputStream(channel);
        BufferedInputStream in = new BufferedInputStream(rawIn);
        Gson gson = new Gson();
        RecursiveGraphLayoutEngine engine = new RecursiveGraphLayoutEngine();

        Mode mode = detectMode(in);
        LOG.info("[" + clientNo + "] Mode = " + mode);

        if (mode == Mode.FRAMED) {
            byte[] jsonBytes;
            while ((jsonBytes = readFramedRequest(in)) != null) {
                LOG.info("[" + clientNo + "] Received framed+gzip JSON (" + jsonBytes.length + " bytes uncompressed)");
                ElkNode graph;
                try {
                    graph = ElkGraphJson.forGraph(new String(jsonBytes, StandardCharsets.UTF_8)).toElk();
                } catch (Exception parse) {
                    LOG.log(Level.SEVERE, "[" + clientNo + "] Parse error", parse);
                    sendFramed(out, gson.toJson(new JsonObjects.Error(parse)).getBytes(StandardCharsets.UTF_8));
                    continue;
                }
                try {
                    engine.layout(graph, new BasicProgressMonitor());
                    StringWriter sw = new StringWriter();
                    writeLayoutData(graph, sw, gson);
                    byte[] response = sw.toString().getBytes(StandardCharsets.UTF_8);
                    sendFramed(out, response);
                    LOG.info("[" + clientNo + "] Sent framed+gzip layout (" + response.length + " bytes uncompressed)");
                } catch (Exception layoutErr) {
                    LOG.log(Level.SEVERE, "[" + clientNo + "] Layout error", layoutErr);
                    sendFramed(out, gson.toJson(new JsonObjects.Error(layoutErr)).getBytes(StandardCharsets.UTF_8));
                }
            }
        } else {
            ElkNode graph;
            while ((graph = readGraph(in)) != null) {
                LOG.info("[" + clientNo + "] Received legacy JSON graph");
                try {
                    engine.layout(graph, new BasicProgressMonitor());
                    OutputStreamWriter writer = new OutputStreamWriter(out, StandardCharsets.UTF_8);
                    writeLayoutData(graph, writer, gson);
                    writer.flush();
                    LOG.info("[" + clientNo + "] Sent legacy JSON layout");
                } catch (Exception exc) {
                    OutputStreamWriter writer = new OutputStreamWriter(out, StandardCharsets.UTF_8);
                    gson.toJson(new JsonObjects.Error(exc), writer);
                    writer.flush();
                    LOG.log(Level.SEVERE, "[" + clientNo + "] Layout error", exc);
                }
            }
        }
    }

    /** Framed when the connection opens with the magic; the bytes stay unread either way. */
    private Mode detectMode(BufferedInputStream in) throws Exception {
        in.mark(HEADER_LEN);
        byte[] probe = in.readNBytes(HEADER_LEN);
        if (probe.length == 0) {
            return Mode.LEGACY;
        }
        if (probe.length < HEADER_LEN) {
            in.reset();
            return Mode.LEGACY;
        }
        boolean magic = hasMagic(probe);
        in.reset();
        return magic ? Mode.FRAMED : Mode.LEGACY;
    }

    /** The next request's JSON, uncompressed; null at the end of the stream. */
    private byte[] readFramedRequest(BufferedInputStream in) throws Exception {
        in.mark(HEADER_LEN);
        byte[] header = in.readNBytes(HEADER_LEN);
        if (header.length == 0) {
            return null;
        }
        if (header.length < HEADER_LEN) {
            throw new EOFException("Truncated header");
        }
        if (!hasMagic(header)) {
            throw new IllegalStateException("Expected magic header for framed request");
        }
        int length = (header[4] & 0xFF) << 24 | (header[5] & 0xFF) << 16 | (header[6] & 0xFF) << 8 | header[7] & 0xFF;
        if (length < 0) {
            throw new IllegalArgumentException("Negative length");
        }
        byte[] comp = in.readNBytes(length);
        if (comp.length != length) {
            throw new EOFException("Truncated compressed payload");
        }
        try (GZIPInputStream gis = new GZIPInputStream(new ByteArrayInputStream(comp))) {
            return gis.readAllBytes();
        }
    }

    private void sendFramed(OutputStream out, byte[] rawJson) throws Exception {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (GZIPOutputStream gzos = new GZIPOutputStream(baos)) {
            gzos.write(rawJson);
        }
        byte[] comp = baos.toByteArray();
        byte[] header = new byte[HEADER_LEN];
        System.arraycopy(MAGIC, 0, header, 0, MAGIC.length);
        int len = comp.length;
        header[4] = (byte) (len >>> 24);
        header[5] = (byte) (len >>> 16);
        header[6] = (byte) (len >>> 8);
        header[7] = (byte) len;
        out.write(header);
        out.write(comp);
        out.flush();
    }

    private static boolean hasMagic(byte[] bytes) {
        return bytes[0] == MAGIC[0] && bytes[1] == MAGIC[1] && bytes[2] == MAGIC[2] && bytes[3] == MAGIC[3];
    }

    public static void main(String[] args) {
        new GzipFramedSocketElkServer().start();
    }

    private enum Mode {
        FRAMED,
        LEGACY
    }
}
