public class Main {
    public static void main(String[] args) {
        double radius = 6_371 + 408;
        double period = 2 * Math.PI * Math.sqrt(Math.pow(radius, 3) / 398_600.4418) / 60;

        System.out.printf("ISS         %6.2f min%n", period);
    }
}
