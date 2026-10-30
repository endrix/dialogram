package io.typefox.elkserver;

import com.google.gson.Gson;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStreamWriter;
import java.net.InetSocketAddress;
import java.nio.channels.AsynchronousServerSocketChannel;
import java.nio.channels.AsynchronousSocketChannel;
import java.nio.channels.Channels;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.logging.Logger;
import org.eclipse.elk.core.RecursiveGraphLayoutEngine;
import org.eclipse.elk.core.util.BasicProgressMonitor;
import org.eclipse.elk.graph.ElkNode;

/**
 * TypeFox's original socket server: plain JSON on localhost:5008. No longer
 * started by {@link ElkServerApplication}, whose {@code --socket} runs
 * {@link GzipFramedSocketElkServer}; kept as the jar had it.
 */
public class SocketElkServer extends AbstractElkServer {

    protected final Logger logger = Logger.getLogger(SocketElkServer.class.getName());

    @Override
    protected void run() throws Exception {
        ExecutorService executorService = Executors.newCachedThreadPool();
        InetSocketAddress address = new InetSocketAddress("localhost", 5008);
        try (AsynchronousServerSocketChannel serverSocket = AsynchronousServerSocketChannel.open().bind(address)) {
            logger.info("ELK Server listening to " + address);
            int nextClientNo = 0;
            while (true) {
                AsynchronousSocketChannel socketChannel = serverSocket.accept().get();
                int clientNo = nextClientNo++;
                logger.info("[" + clientNo + "] Accepted new connection.");
                executorService.submit(() -> {
                    try {
                        handle(socketChannel, clientNo);
                        logger.info("[" + clientNo + "] Closed connection.");
                    } catch (Exception exc) {
                        logger.severe("[" + clientNo + "]" + exc.getMessage());
                        exc.printStackTrace();
                    }
                });
            }
        } finally {
            executorService.shutdown();
        }
    }

    protected void handle(AsynchronousSocketChannel socketChannel, int clientNo) throws IOException {
        InputStream input = Channels.newInputStream(socketChannel);
        OutputStreamWriter writer = new OutputStreamWriter(Channels.newOutputStream(socketChannel), StandardCharsets.UTF_8);
        RecursiveGraphLayoutEngine engine = new RecursiveGraphLayoutEngine();
        Gson gson = new Gson();
        ElkNode graph;
        while ((graph = readGraph(input)) != null) {
            logger.info("[" + clientNo + "] Received input graph.");
            try {
                engine.layout(graph, new BasicProgressMonitor());
                logger.info("[" + clientNo + "] Computed layout.");
                writeLayoutData(graph, writer, gson);
                writer.flush();
                logger.info("[" + clientNo + "] Sent JSON data.");
            } catch (Exception exc) {
                gson.toJson(new JsonObjects.Error(exc), writer);
            }
        }
    }
}
