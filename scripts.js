jQuery(document).ready(function($) {
    $('.slick.marquee').slick({
      speed: 5000,
      autoplay: true,
      autoplaySpeed: 0,
      centerMode: true,
      cssEase: 'linear',
      slidesToShow: 1,
      slidesToScroll: 1,
      variableWidth: true,
      infinite: true,
      initialSlide: 1,
      arrows: false,
      buttons: false
    });
  });

  
const glow = document.createElement('div');
glow.classList.add('glow');
document.body.appendChild(glow);

document.addEventListener('mousemove', (e) => {
  
  glow.style.transform = `translate(${e.clientX - 25}px, ${e.clientY - 25}px)`;
});

  
  